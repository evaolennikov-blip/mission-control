/**
 * WORKFLOW.md Loader (Symphony pattern)
 *
 * Reads a WORKFLOW.md file with YAML-like front matter that defines:
 * - Workflow stages, roles, and fail targets
 * - Reconciler configuration (interval, stall timeout, retries)
 * - Concurrency limits
 *
 * Hot-reloads on file change via fs.watchFile.
 * Falls back to DB-stored workflow templates if no file exists.
 */

import fs from 'fs';
import path from 'path';
import type { WorkflowStage, TaskStatus } from '@/lib/types';

export interface WorkflowFileConfig {
  name: string;
  default: boolean;
  stages: WorkflowStage[];
  fail_targets: Record<string, string>;
  reconciler: {
    interval_ms: number;
    stall_timeout_ms: number;
    max_retries: number;
    max_retry_backoff_ms: number;
  };
  agent: {
    max_concurrent_tasks: number;
  };
  /** The markdown body below the front matter */
  body: string;
}

// Cached config — reloaded on file change
let cachedConfig: WorkflowFileConfig | null = null;
let watchActive = false;

const DEFAULT_CONFIG: WorkflowFileConfig = {
  name: 'Strict Pipeline',
  default: true,
  stages: [
    { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' as TaskStatus },
    { id: 'test', label: 'Test', role: 'tester', status: 'testing' as TaskStatus },
    { id: 'review', label: 'Review', role: null, status: 'review' as TaskStatus },
    { id: 'verify', label: 'Verify', role: 'reviewer', status: 'verification' as TaskStatus },
    { id: 'done', label: 'Done', role: null, status: 'done' as TaskStatus },
  ],
  fail_targets: {
    testing: 'in_progress',
    review: 'in_progress',
    verification: 'in_progress',
  },
  reconciler: {
    interval_ms: 30_000,
    stall_timeout_ms: 1_800_000,
    max_retries: 5,
    max_retry_backoff_ms: 300_000,
  },
  agent: {
    max_concurrent_tasks: 3,
  },
  body: '',
};

/**
 * Get the path to WORKFLOW.md (workspace root or configured path)
 */
function getWorkflowFilePath(): string {
  return path.join(process.cwd(), 'WORKFLOW.md');
}

/**
 * Parse simple YAML-like front matter.
 * Supports: scalars, simple arrays (- item), and one-level nested objects.
 */
function parseFrontMatter(content: string): { data: Record<string, unknown>; body: string } {
  const lines = content.split('\n');

  // Check for --- delimiter
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { data: {}, body: content };
  }

  const yamlLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n').trim();
  const data: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;
  let objectKey: string | null = null;

  for (const line of yamlLines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Array item: "  - value" or "  - id: xxx"
    const arrayMatch = line.match(/^\s+-\s+(.*)/);
    if (arrayMatch && currentKey) {
      if (!currentArray) {
        currentArray = [];
        // If we had an object building, save it
        if (currentObject && objectKey) {
          data[objectKey] = currentObject;
          currentObject = null;
          objectKey = null;
        }
      }

      const itemValue = arrayMatch[1].trim();
      // Check if it's a complex array item (has colons — like stage definition)
      if (itemValue.includes(':')) {
        // Parse inline object: "id: build, label: Build, ..."
        // Or YAML block object (will be handled by subsequent lines)
        const obj = parseInlineObject(itemValue);
        currentArray.push(obj);
      } else {
        currentArray.push(parseValue(itemValue));
      }
      continue;
    }

    // Nested key-value: "  key: value" (2+ space indent, under an object key)
    const nestedMatch = line.match(/^(\s{2,})(\w[\w_]*)\s*:\s*(.*)/);
    if (nestedMatch && currentObject && objectKey) {
      const [, , nestedKey, nestedVal] = nestedMatch;
      currentObject[nestedKey] = parseValue(nestedVal.trim());
      continue;
    }

    // Top-level key: value
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (kvMatch) {
      // Save previous state
      if (currentArray && currentKey) {
        data[currentKey] = currentArray;
        currentArray = null;
      }
      if (currentObject && objectKey) {
        data[objectKey] = currentObject;
        currentObject = null;
        objectKey = null;
      }

      const [, key, value] = kvMatch;
      currentKey = key;

      if (value.trim() === '') {
        // Could be an array or object — wait for next lines
        // Peek: if next non-empty line starts with "  -", it's an array; if "  key:", it's an object
        const nextNonEmpty = yamlLines.slice(yamlLines.indexOf(line) + 1).find(l => l.trim() !== '');
        if (nextNonEmpty?.match(/^\s+-/)) {
          currentArray = [];
        } else if (nextNonEmpty?.match(/^\s{2,}\w/)) {
          currentObject = {};
          objectKey = key;
        }
      } else {
        data[key] = parseValue(value.trim());
      }
    }
  }

  // Save any trailing state
  if (currentArray && currentKey) {
    data[currentKey] = currentArray;
  }
  if (currentObject && objectKey) {
    data[objectKey] = currentObject;
  }

  return { data, body };
}

function parseValue(val: string): unknown {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  // Strip quotes
  if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseInlineObject(line: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  // Split on ", " but be careful with values that might contain commas
  const pairs = line.split(/,\s*/);
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx > 0) {
      const key = pair.slice(0, colonIdx).trim();
      const value = pair.slice(colonIdx + 1).trim();
      obj[key] = parseValue(value);
    }
  }
  return obj;
}

/**
 * Load and parse WORKFLOW.md into a typed config.
 * Returns null if the file doesn't exist.
 */
function loadWorkflowFile(): WorkflowFileConfig | null {
  const filePath = getWorkflowFilePath();

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data, body } = parseFrontMatter(content);

    // Map parsed data to typed config, with defaults
    const config: WorkflowFileConfig = {
      name: (data.name as string) || DEFAULT_CONFIG.name,
      default: data.default !== undefined ? Boolean(data.default) : DEFAULT_CONFIG.default,
      stages: Array.isArray(data.stages)
        ? (data.stages as Record<string, unknown>[]).map(s => ({
            id: String(s.id || ''),
            label: String(s.label || ''),
            role: s.role === null || s.role === 'null' ? null : String(s.role || ''),
            status: String(s.status || '') as TaskStatus,
          }))
        : DEFAULT_CONFIG.stages,
      fail_targets: (data.fail_targets as Record<string, string>) || DEFAULT_CONFIG.fail_targets,
      reconciler: {
        interval_ms: Number((data.reconciler as Record<string, unknown>)?.interval_ms) || DEFAULT_CONFIG.reconciler.interval_ms,
        stall_timeout_ms: Number((data.reconciler as Record<string, unknown>)?.stall_timeout_ms) || DEFAULT_CONFIG.reconciler.stall_timeout_ms,
        max_retries: Number((data.reconciler as Record<string, unknown>)?.max_retries) || DEFAULT_CONFIG.reconciler.max_retries,
        max_retry_backoff_ms: Number((data.reconciler as Record<string, unknown>)?.max_retry_backoff_ms) || DEFAULT_CONFIG.reconciler.max_retry_backoff_ms,
      },
      agent: {
        max_concurrent_tasks: Number((data.agent as Record<string, unknown>)?.max_concurrent_tasks) || DEFAULT_CONFIG.agent.max_concurrent_tasks,
      },
      body,
    };

    console.log(`[WorkflowLoader] Loaded WORKFLOW.md: "${config.name}" with ${config.stages.length} stages`);
    return config;
  } catch (err) {
    console.error('[WorkflowLoader] Failed to parse WORKFLOW.md:', err);
    return null;
  }
}

/**
 * Start watching WORKFLOW.md for changes. Hot-reloads on change.
 */
function startWatching(): void {
  if (watchActive) return;

  const filePath = getWorkflowFilePath();
  try {
    fs.watchFile(filePath, { interval: 2000 }, () => {
      console.log('[WorkflowLoader] WORKFLOW.md changed — reloading');
      cachedConfig = loadWorkflowFile();
    });
    watchActive = true;
  } catch {
    // watchFile may fail in some environments — graceful fallback
    console.warn('[WorkflowLoader] Could not watch WORKFLOW.md for changes');
  }
}

/**
 * Get the workflow config from WORKFLOW.md (cached, hot-reloaded).
 * Returns null if no WORKFLOW.md exists (caller should fall back to DB).
 */
export function getFileWorkflowConfig(): WorkflowFileConfig | null {
  if (cachedConfig === undefined || cachedConfig === null) {
    cachedConfig = loadWorkflowFile();
    startWatching();
  }
  return cachedConfig;
}

/**
 * Get the default config (used when no WORKFLOW.md exists and no DB template).
 */
export function getDefaultWorkflowConfig(): WorkflowFileConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Force-reload WORKFLOW.md (useful for testing or after manual edits).
 */
export function reloadWorkflowConfig(): WorkflowFileConfig | null {
  cachedConfig = loadWorkflowFile();
  return cachedConfig;
}
