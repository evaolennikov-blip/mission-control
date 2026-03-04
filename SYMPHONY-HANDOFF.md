# Symphony Integration — Handoff Document

**Branch:** `symphony`
**Base:** `main` @ `98058ca`
**Date:** 2026-03-04

---

## Goal

Upgrade Autensa's execution reliability by borrowing the best ideas from [OpenAI's Symphony](https://github.com/openai/symphony) — without over-engineering. Symphony is a daemon that polls an issue tracker, creates isolated workspaces per issue, runs coding agents, and manages retries/reconciliation. We're taking the practical patterns and fitting them to Autensa's existing architecture (Next.js 14 + SQLite + OpenClaw Gateway).

---

## What We're Building (5 Phases)

### Phase 1: Fix Race Conditions (atomic dispatch)

**Problem:** Status update, agent assignment, and dispatch happen as separate non-transactional steps. Two concurrent PATCH requests can double-dispatch or leave a task stranded.

**Fix:**
- Wrap the critical path in `workflow-engine.ts` `handleStageTransition()` in a SQLite transaction: read task → check claimed → assign agent → update status → commit. Dispatch to OpenClaw happens AFTER the transaction commits (fire-and-forget with error recording).
- Add a `dispatch_lock` column to `tasks` table — a simple claimed-state flag (`dispatch_lock TEXT` storing the agent ID that owns the dispatch, or NULL). Check-and-set this atomically via `UPDATE tasks SET dispatch_lock = ? WHERE id = ? AND dispatch_lock IS NULL`.
- Fix `drainQueue()` TOCTOU: use `UPDATE tasks SET status = ? WHERE id = ? AND status = ?` (optimistic lock) instead of separate SELECT + UPDATE.
- Same fix in `PATCH /api/tasks/[id]/route.ts`: the status update + workflow trigger should be atomic.

**Files to modify:**
- `src/lib/workflow-engine.ts` — wrap `handleStageTransition()`, `handleStageFailure()`, `drainQueue()` in transactions
- `src/app/api/tasks/[id]/route.ts` — atomic status check-and-update before triggering workflow
- `src/lib/db/migrations.ts` — migration 014: add `dispatch_lock` and `retry_count`/`next_retry_at` columns to tasks

### Phase 2: Retry with Backoff

**Problem:** When dispatch fails (OpenClaw down, agent offline), the error is stored in `planning_dispatch_error` and the user must manually retry. No automatic recovery.

**Fix:**
- Add two columns to `tasks`: `retry_count INTEGER DEFAULT 0` and `next_retry_at TEXT` (ISO timestamp).
- When dispatch fails in `handleStageTransition()`, instead of just logging the error:
  1. Increment `retry_count`
  2. Compute `next_retry_at = now + min(10000 * 2^(retry_count - 1), 300000)` ms (exponential backoff, max 5 min)
  3. Store both + the error message
- The reconciliation tick (Phase 3) picks these up automatically.
- On successful dispatch, reset `retry_count = 0` and `next_retry_at = NULL`.
- Max retries: 5 (configurable). After max retries, mark task with permanent error and stop retrying.

**Files to modify:**
- `src/lib/workflow-engine.ts` — add retry scheduling logic in dispatch error paths
- `src/lib/db/migrations.ts` — migration 014 (same migration, add columns)

### Phase 3: Reconciliation Loop (Symphony's core pattern)

**Problem:** Stuck tasks are invisible. If an agent goes silent, the task sits in `in_progress` forever. No stall detection, no automatic recovery.

**Fix:** Create `src/lib/reconciler.ts` — a `setInterval`-based loop that runs every 30 seconds:

1. **Retry dispatch:** Find tasks where `next_retry_at <= now AND next_retry_at IS NOT NULL AND retry_count < max_retries`. For each, attempt dispatch via `handleStageTransition()`.

2. **Stall detection:** Find tasks in `assigned`/`in_progress`/`testing`/`verification` where `updated_at < now - stall_threshold` (default: 30 minutes, configurable). For each:
   - Check the last `task_activity` timestamp — if recent, the agent is alive, skip.
   - If truly stalled: log a `stalled` activity, set `planning_dispatch_error = 'Stall detected: no activity for N minutes'`, optionally retry dispatch.

3. **Session cleanup:** Find `openclaw_sessions` with `status = 'active'` where the linked agent's task is `done` or the session is older than 24h. Mark them `ended`.

4. **Queue drain:** Call `drainQueue()` for each workspace that has tasks in queue stages. This catches any tasks that got stuck in `review` because a previous drain failed silently.

**Startup/shutdown:**
- Start the reconciler in `src/lib/db/index.ts` after migrations run (or in a dedicated init module).
- For Next.js, use a module-level singleton pattern. The reconciler should be idempotent (safe to call from multiple API routes during dev hot-reload).

**Files to create:**
- `src/lib/reconciler.ts` — the reconciliation loop

**Files to modify:**
- `src/lib/db/index.ts` or create `src/lib/init.ts` — start the reconciler on first DB access

### Phase 4: WORKFLOW.md (Symphony's best idea)

**Problem:** Workflow templates are stored as JSON blobs in the DB, editable only through the UI. No version control, no hot-reload, no repo-level customization.

**Fix:** Borrow Symphony's `WORKFLOW.md` concept — a markdown file with YAML front matter that defines the workflow:

```markdown
---
name: Strict Pipeline
default: true
stages:
  - id: build
    label: Build
    role: builder
    status: in_progress
  - id: test
    label: Test
    role: tester
    status: testing
  - id: review
    label: Review
    role: null
    status: review
  - id: verify
    label: Verify
    role: reviewer
    status: verification
  - id: done
    label: Done
    role: null
    status: done
fail_targets:
  testing: in_progress
  review: in_progress
  verification: in_progress
reconciler:
  interval_ms: 30000
  stall_timeout_ms: 1800000
  max_retries: 5
  max_retry_backoff_ms: 300000
agent:
  max_concurrent_tasks: 3
---

## Workflow Policy

Tasks flow through Build → Test → Review (queue) → Verify → Done.
Failed stages loop back to the builder.
```

**Implementation:**
- Create `src/lib/workflow-loader.ts`:
  - Reads `WORKFLOW.md` from the workspace root (or a configured path)
  - Parses YAML front matter + markdown body (use `gray-matter` or hand-roll the `---` parsing)
  - Returns typed `WorkflowConfig` object
  - Watches for file changes (`fs.watchFile` or `chokidar`) and hot-reloads
  - Falls back to DB-stored templates if no file exists (backwards compatible)
- Modify `workflow-engine.ts`: `getTaskWorkflow()` checks file-based config first, then DB
- The reconciler reads its config (interval, stall timeout, max retries) from the workflow file
- The markdown body becomes the workspace's default prompt template for agent dispatches (future use)

**Files to create:**
- `src/lib/workflow-loader.ts`
- `WORKFLOW.md` (default template in project root)

**Files to modify:**
- `src/lib/workflow-engine.ts` — `getTaskWorkflow()` to support file-based source
- `src/lib/reconciler.ts` — read config from workflow loader

### Phase 5: Bounded Concurrency (Symphony pattern)

**Problem:** No limit on how many tasks can be dispatched simultaneously. If 10 tasks arrive at once, all 10 get dispatched, potentially overwhelming the agent gateway.

**Fix:**
- Add concurrency tracking to the reconciler/orchestrator:
  - `max_concurrent_tasks` from WORKFLOW.md (default: 3)
  - Before dispatching, count tasks in active states (`assigned`, `in_progress`, `testing`, `verification`) per workspace
  - If at max, don't dispatch — the task stays in `inbox`/`assigned` until a slot opens
  - When a task completes/fails, the reconciler's queue drain picks up the next one
- This naturally works with the existing queue mechanism in `drainQueue()`.

**Files to modify:**
- `src/lib/workflow-engine.ts` — add concurrency check before dispatch in `handleStageTransition()`
- `src/lib/reconciler.ts` — respect concurrency limits during retry dispatch

---

## Migration Plan (migration 014)

```sql
-- Add retry tracking columns to tasks
ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN next_retry_at TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_lock TEXT;
```

This is a single non-breaking migration. No table recreation needed.

---

## Key Architecture Decisions

1. **No new tables.** Unlike the original plan's 4-table execution ledger, we add 3 columns to the existing `tasks` table. SQLite transactions give us mutual exclusion — we don't need leases.

2. **In-process reconciler, not a separate service.** The reconciler runs as a `setInterval` inside the Next.js process. This matches Symphony's single-process model. If PM2 restarts the process, the reconciler restarts with it.

3. **File-first, DB-fallback for workflows.** WORKFLOW.md takes precedence when present. The DB templates remain as fallback for workspaces that don't have a file. This makes workflows version-controllable without breaking existing behavior.

4. **Fire-and-forget dispatch, reconciler catches failures.** The dispatch call to OpenClaw is intentionally async/non-transactional. If it fails, the retry columns are set, and the reconciler picks it up. This keeps the critical path (status update) fast and atomic.

---

## Current Codebase State

### Uncommitted changes on main (carried into this branch):
- `src/components/TaskModal.tsx` — v1.4.0 multi-agent UI changes (staged)
- `src/lib/validation.ts` — validation changes (unstaged)

### Key files you'll work with:
| File | Purpose |
|------|---------|
| `src/lib/workflow-engine.ts` | Core orchestration: `handleStageTransition()`, `handleStageFailure()`, `drainQueue()`, `populateTaskRolesFromAgents()` |
| `src/app/api/tasks/[id]/route.ts` | PATCH handler — triggers workflow transitions, dispatches, queue drain |
| `src/app/api/tasks/[id]/dispatch/route.ts` | Sends task to agent via OpenClaw WebSocket (`chat.send`) |
| `src/lib/db/migrations.ts` | 13 existing migrations. Add migration 014 here. |
| `src/lib/db/index.ts` | DB singleton, `getDb()`, `queryOne`, `queryAll`, `run`, `transaction` |
| `src/lib/events.ts` | SSE `broadcast()` to connected UI clients |
| `src/lib/types.ts` | All TypeScript interfaces (`Task`, `WorkflowTemplate`, `WorkflowStage`, etc.) |
| `src/lib/config.ts` | `getMissionControlUrl()`, `getProjectsPath()` |
| `src/lib/openclaw/client.ts` | WebSocket client to OpenClaw Gateway |
| `src/lib/auto-dispatch.ts` | Client-side dispatch helper (used by planning retry) |
| `src/lib/learner.ts` | Knowledge injection into dispatch messages |

### Existing patterns to follow:
- Migrations: check column existence with `PRAGMA table_info()` before `ALTER TABLE`
- DB access: use `queryOne<T>()`, `queryAll<T>()`, `run()`, `transaction()` from `@/lib/db`
- Events: call `broadcast({ type: 'task_updated', payload: task })` after mutations
- Logging: `console.log('[Module] message')` format with bracketed prefix
- IDs: `crypto.randomUUID()` for new records
- Timestamps: `new Date().toISOString()` or `datetime('now')` in SQL

### Task lifecycle:
```
planning → inbox → assigned → in_progress → testing → review (queue) → verification → done
                                    ↑ FAIL ←── testing/review/verification
```

### Workflow template structure (JSON in `stages` column):
```json
[
  { "id": "build", "label": "Build", "role": "builder", "status": "in_progress" },
  { "id": "test", "label": "Test", "role": "tester", "status": "testing" },
  { "id": "review", "label": "Review", "role": null, "status": "review" },
  { "id": "verify", "label": "Verify", "role": "reviewer", "status": "verification" },
  { "id": "done", "label": "Done", "role": null, "status": "done" }
]
```

### Environment:
- PM2 process: `mission-control` on port 4000
- DB: `./mission-control.db` (SQLite, WAL mode)
- Gateway: `ws://127.0.0.1:18789` (OpenClaw)
- Auth: `MC_API_TOKEN` in `.env.local`

---

## Implementation Order

1. **Migration 014** — add `retry_count`, `next_retry_at`, `dispatch_lock` columns
2. **Phase 1** — atomic dispatch (transactions + dispatch_lock)
3. **Phase 2** — retry with backoff (on dispatch failure, schedule retry)
4. **Phase 3** — reconciler loop (picks up retries, detects stalls, drains queues)
5. **Phase 4** — WORKFLOW.md loader + hot-reload
6. **Phase 5** — bounded concurrency

Each phase is independently testable. After Phase 3, the system is materially more reliable. Phases 4-5 are additive improvements.

---

## Symphony Spec Reference

The full Symphony SPEC.md was read and analyzed. Key sections that informed this plan:
- **Section 7** (Orchestration State Machine): Unclaimed → Claimed → Running → RetryQueued → Released. We simplified this to the `dispatch_lock` + `retry_count`/`next_retry_at` pattern.
- **Section 8** (Polling, Scheduling, Reconciliation): Poll loop + reconciliation on every tick + exponential backoff retry. We adopted this directly.
- **Section 5** (WORKFLOW.md): YAML front matter + markdown body, hot-reload, typed config getters. We adopted the concept with Autensa-specific schema.
- **Section 8.3** (Concurrency Control): Global + per-state limits. We adopted the global limit (`max_concurrent_tasks`).

---

## What We're NOT Building

- **Lease/heartbeat system** — unnecessary for single-process SQLite
- **Separate run_attempts/run_events tables** — retry state lives on the task itself
- **Dark launch / canary rollout** — just test and deploy
- **Issue tracker integration** — Autensa IS the tracker (Symphony reads from Linear; we don't need that)
- **Workspace isolation** — deferred; would require per-task git worktrees or directories, which is a bigger change to the OpenClaw dispatch model
