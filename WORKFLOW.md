---
name: Strict Pipeline
default: true
stages:
  - id: build, label: Build, role: builder, status: in_progress
  - id: test, label: Test, role: tester, status: testing
  - id: review, label: Review, role: null, status: review
  - id: verify, label: Verify, role: reviewer, status: verification
  - id: done, label: Done, role: null, status: done
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

- **Build** (builder): Implements the task. Creates deliverables in the output directory.
- **Test** (tester): Runs tests against the deliverables. Passes or fails back to builder.
- **Review** (queue): Waiting stage — no agent runs here. Tasks queue until verification slot opens.
- **Verify** (reviewer): Final quality check. Passes to done or fails back to builder.
- **Done**: Task complete.

### Failure Loopback

When testing, review, or verification fails, the task returns to `in_progress` (the builder).
The builder receives the failure reason and must fix the issues before the task advances again.

### Concurrency

At most `max_concurrent_tasks` tasks run simultaneously per workspace.
When a slot opens (task completes/fails), the reconciler drains the queue.

### Reconciliation

A background loop runs every `interval_ms` to:
1. Retry failed dispatches (exponential backoff)
2. Detect stalled tasks (no activity for `stall_timeout_ms`)
3. Clean up orphaned agent sessions
4. Drain queued tasks when slots open
