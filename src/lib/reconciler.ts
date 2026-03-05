/**
 * Reconciliation Loop (Symphony pattern)
 *
 * Runs on a timer (default 30s) to catch and recover from:
 * 1. Failed dispatches that need retry (next_retry_at <= now)
 * 2. Stalled tasks (no activity for stall_timeout)
 * 3. Orphaned OpenClaw sessions
 * 4. Stuck queue stages that need draining
 *
 * Singleton pattern: safe for Next.js hot-reload (dev mode).
 */

import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { handleStageTransition, drainQueue, getTaskWorkflow, getConcurrencyLimit } from '@/lib/workflow-engine';
import { broadcast } from '@/lib/events';
import { getFileWorkflowConfig } from '@/lib/workflow-loader';
import type { Task, WorkflowTemplate } from '@/lib/types';

// --- Configuration defaults (overridden by WORKFLOW.md when present) ---
const DEFAULT_INTERVAL_MS = 30_000;        // 30 seconds
const DEFAULT_STALL_TIMEOUT_MS = 1_800_000; // 30 minutes
const DEFAULT_MAX_RETRIES = 5;

interface ReconcilerConfig {
  interval_ms: number;
  stall_timeout_ms: number;
  max_retries: number;
}

let reconcilerInterval: ReturnType<typeof setInterval> | null = null;
let reconcilerRunning = false;

/**
 * Get reconciler config from WORKFLOW.md (if present), else defaults.
 */
export function getReconcilerConfig(): ReconcilerConfig {
  const fileConfig = getFileWorkflowConfig();
  if (fileConfig) {
    return {
      interval_ms: fileConfig.reconciler.interval_ms,
      stall_timeout_ms: fileConfig.reconciler.stall_timeout_ms,
      max_retries: fileConfig.reconciler.max_retries,
    };
  }
  return {
    interval_ms: DEFAULT_INTERVAL_MS,
    stall_timeout_ms: DEFAULT_STALL_TIMEOUT_MS,
    max_retries: DEFAULT_MAX_RETRIES,
  };
}

/**
 * Start the reconciler loop. Idempotent — safe to call multiple times.
 */
export function startReconciler(): void {
  if (reconcilerInterval) {
    return; // Already running
  }

  const config = getReconcilerConfig();
  console.log(`[Reconciler] Starting with interval=${config.interval_ms}ms, stall_timeout=${config.stall_timeout_ms}ms`);

  reconcilerInterval = setInterval(() => {
    runReconciliationTick().catch(err =>
      console.error('[Reconciler] Tick failed:', err)
    );
  }, config.interval_ms);

  // Don't block process exit
  if (reconcilerInterval.unref) {
    reconcilerInterval.unref();
  }
}

/**
 * Stop the reconciler loop.
 */
export function stopReconciler(): void {
  if (reconcilerInterval) {
    clearInterval(reconcilerInterval);
    reconcilerInterval = null;
    console.log('[Reconciler] Stopped');
  }
}

/**
 * Run a single reconciliation tick. Each sub-step is independent and non-blocking.
 */
async function runReconciliationTick(): Promise<void> {
  if (reconcilerRunning) {
    return; // Previous tick still running — skip
  }
  reconcilerRunning = true;

  try {
    await retryFailedDispatches();
    await detectStalledTasks();
    cleanupOrphanedSessions();
    await drainAllQueues();
  } finally {
    reconcilerRunning = false;
  }
}

/**
 * Step 1: Retry dispatch for tasks with next_retry_at <= now
 */
async function retryFailedDispatches(): Promise<void> {
  const config = getReconcilerConfig();
  const now = new Date().toISOString();

  const retryable = queryAll<{ id: string; status: string; retry_count: number; workspace_id: string }>(
    `SELECT id, status, retry_count, workspace_id FROM tasks
     WHERE next_retry_at IS NOT NULL
       AND next_retry_at <= ?
       AND retry_count <= ?
       AND status NOT IN ('done', 'inbox', 'planning')`,
    [now, config.max_retries]
  );

  // Check concurrency per workspace before retrying
  const maxConcurrent = getConcurrencyLimit();

  for (const task of retryable) {
    // Respect concurrency limits
    const activeCount = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE workspace_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification')
       AND id != ?`,
      [task.workspace_id, task.id]
    );
    if (activeCount && activeCount.count >= maxConcurrent) {
      console.log(`[Reconciler] Concurrency limit reached for workspace ${task.workspace_id} — deferring retry for task ${task.id}`);
      continue;
    }

    console.log(`[Reconciler] Retrying dispatch for task ${task.id} (attempt ${task.retry_count})`);

    // Clear next_retry_at so we don't re-pick this task on the next tick
    run('UPDATE tasks SET next_retry_at = NULL WHERE id = ?', [task.id]);

    try {
      await handleStageTransition(task.id, task.status);
    } catch (err) {
      console.error(`[Reconciler] Retry dispatch failed for task ${task.id}:`, err);
    }
  }
}

/**
 * Step 2: Detect stalled tasks — no activity for stall_timeout
 */
async function detectStalledTasks(): Promise<void> {
  const config = getReconcilerConfig();
  const stallThreshold = new Date(Date.now() - config.stall_timeout_ms).toISOString();

  // Find tasks in active states with no recent update
  const stalled = queryAll<{ id: string; title: string; status: string; assigned_agent_id: string | null; updated_at: string }>(
    `SELECT id, title, status, assigned_agent_id, updated_at FROM tasks
     WHERE status IN ('assigned', 'in_progress', 'testing', 'verification')
       AND updated_at < ?
       AND (next_retry_at IS NULL OR next_retry_at < ?)`,
    [stallThreshold, new Date().toISOString()]
  );

  for (const task of stalled) {
    // Check if there's been recent activity (task_activities) even though the task itself wasn't updated
    const recentActivity = queryOne<{ id: string }>(
      'SELECT id FROM task_activities WHERE task_id = ? AND created_at > ? LIMIT 1',
      [task.id, stallThreshold]
    );

    if (recentActivity) {
      continue; // Agent is alive, just hasn't updated the task row
    }

    // Check if the agent has an active OpenClaw session linked to this task
    // If a session is active, the agent is likely still working — just hasn't logged progress
    if (task.assigned_agent_id) {
      const activeSession = queryOne<{ id: string; updated_at: string }>(
        `SELECT id, updated_at FROM openclaw_sessions
         WHERE agent_id = ? AND status = 'active' AND task_id = ?`,
        [task.assigned_agent_id, task.id]
      );
      if (activeSession) {
        // Session exists and is linked to this task — skip stall, just log a note
        console.log(`[Reconciler] Task ${task.id} has active session — skipping stall detection`);
        continue;
      }
    }

    console.warn(`[Reconciler] Stalled task detected: ${task.id} "${task.title}" in ${task.status} since ${task.updated_at}`);

    // Log a stall activity
    const now = new Date().toISOString();
    const stallMinutes = Math.round(config.stall_timeout_ms / 60_000);
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (?, ?, 'status_changed', ?, ?)`,
      [
        crypto.randomUUID(),
        task.id,
        `Stall detected: no activity for ${stallMinutes}+ minutes. Scheduling retry dispatch.`,
        now,
      ]
    );

    // Set dispatch error and schedule a retry
    run(
      `UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
      [`Stall detected: no activity for ${stallMinutes}+ minutes`, now, task.id]
    );

    // Attempt re-dispatch
    try {
      await handleStageTransition(task.id, task.status);
    } catch (err) {
      console.error(`[Reconciler] Re-dispatch after stall failed for task ${task.id}:`, err);
    }

    // Broadcast so UI shows the stall banner
    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
    }
  }
}

/**
 * Step 3: Cleanup orphaned OpenClaw sessions
 */
function cleanupOrphanedSessions(): void {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Sessions for tasks that are done
  const doneSessions = run(
    `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ?
     WHERE status = 'active'
       AND task_id IN (SELECT id FROM tasks WHERE status = 'done')`,
    [now, now]
  );
  if (doneSessions.changes > 0) {
    console.log(`[Reconciler] Ended ${doneSessions.changes} sessions for completed tasks`);
  }

  // Sessions older than 24 hours
  const oldSessions = run(
    `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ?
     WHERE status = 'active' AND created_at < ?`,
    [now, now, cutoff24h]
  );
  if (oldSessions.changes > 0) {
    console.log(`[Reconciler] Ended ${oldSessions.changes} sessions older than 24h`);
  }
}

/**
 * Step 4: Drain queues for all workspaces
 */
async function drainAllQueues(): Promise<void> {
  // Find workspaces with tasks in queue stages (e.g., 'review')
  const workspacesWithQueued = queryAll<{ workspace_id: string; task_id: string }>(
    `SELECT DISTINCT workspace_id, id as task_id FROM tasks
     WHERE status = 'review'
     ORDER BY workspace_id`
  );

  for (const { workspace_id, task_id } of workspacesWithQueued) {
    try {
      await drainQueue(task_id, workspace_id);
    } catch (err) {
      console.error(`[Reconciler] drainQueue failed for workspace ${workspace_id}:`, err);
    }
  }
}
