# MCP Bridge Complete Guide

This document describes the current Codex -> MCP Bridge -> OpenCode multi-agent operating model.

It is meant to be a practical reference for a future human maintainer, Codex orchestrator, OpenCode orchestrator, reviewer, tester, or builder.

## 1. Main Idea

The system is built around one simple rule:

```text
Codex is the primary orchestrator.
OpenCode agents are execution workers.
The MCP Bridge is the safety and routing layer between them.
```

Core flow:

```text
User
-> Codex
-> MCP Bridge
-> OpenCode CLI
-> OpenCode Agents
-> MCP validation
-> Codex final review
```

Codex decides what should happen. The MCP Bridge checks whether the delegation is safe. OpenCode agents execute bounded tasks. Codex reviews the result before answering the user.

## 2. Global Scope

This is a global setup, not a project-local setup.

Main locations:

```text
<repo>\
%USERPROFILE%\.codex\
%USERPROFILE%\.config\opencode\agents\
```

Do not create repo-local agent or Spec Kit folders unless the user explicitly asks:

```text
repo/.opencode/
repo/.specify/
repo/specs/
```

## 3. Main MCP Tools

### validate_delegation_plan

Use this before risky or parallel work.

It does not run OpenCode agents.
It does not acquire locks.

It checks:

- agent routing
- missing agents
- fallback behavior
- lock mode
- path normalization
- unsafe paths
- overlapping parallel write scopes
- active lock conflicts
- effective timeout per job
- queue status: can run immediately, must wait, or conflict

Recommended flow:

```text
Codex
-> validate_delegation_plan
-> run_opencode_agent or run_opencode_parallel
-> MCP validation
-> Codex review
```

### run_opencode_agent

Runs one OpenCode agent.

Use for:

- one planner
- one reviewer
- one tester
- one builder
- one debugger
- one orchestrator delegation

For write agents, MCP automatically acquires and releases a temporary lock.

### run_opencode_parallel

Runs multiple OpenCode jobs in parallel.

Use only when jobs are independent.

Read-only jobs can run in parallel freely.
Parallel write jobs must have non-overlapping normalized paths.

### enqueue_opencode_job

Adds one OpenCode job to the MCP queue. It uses the same Scope Contract, lock plan, path safety, and changed-file validation model as `run_opencode_agent`.

Use the queue when Codex wants scheduling, status tracking, cancellation, or automatic waiting for conflicting writers.

### list_opencode_jobs / get_opencode_job / cancel_opencode_job

Queue management tools:

- `list_opencode_jobs`: list pending, blocked, running, completed, failed, or cancelled jobs.
- `get_opencode_job`: inspect one job, including result text when available.
- `cancel_opencode_job`: cancel pending/blocked jobs immediately, or request cancellation for a running job.

### list_opencode_agents

Lists OpenCode agents known to the CLI.

### acquire_agent_lock / release_agent_lock / list_agent_locks

Manual lock tools exist only for exceptional/debug cleanup.

They are not part of the normal builder/debugger workflow.

Do not manually acquire a lock before calling `run_opencode_agent`.

## 4. Direct Agent Routing

The bridge expects direct routing:

```text
planner      -> opencode run --agent planner
reviewer     -> opencode run --agent reviewer
tester       -> opencode run --agent tester
architect    -> opencode run --agent architect
builder      -> opencode run --agent builder
debugger     -> opencode run --agent debugger
orchestrator -> opencode run --agent orchestrator
```

No silent fallback is allowed.

Fallback to `build` happens only when `allowFallbackToBuild: true` is explicitly set.

If fallback happens, the result reports:

```text
requestedAgent
actualAgent
fallback
fallbackReason
```

## 5. Normal Operating Model

### Read-only work

Use read-only agents without locks:

```json
{
  "agent": "reviewer",
  "task": "Review the current diff. Do not edit files.",
  "lockMode": "off"
}
```

Read-only agents:

- `planner`
- `architect`
- `reviewer`
- `tester`

### One writer

Use `lockMode: "simple"`.

```json
{
  "agent": "builder",
  "task": "Implement only the web UI change.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/web/**"]
}
```

The bridge normalizes:

```text
apps/web/** -> apps/web
```

Then:

```text
MCP acquires temporary lock
-> builder runs
-> MCP checks changed files
-> MCP releases lock
```

### Multiple writers

Use parallel only when paths do not overlap:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Edit the web app.",
      "write": true,
      "lockedPaths": ["apps/web/**"]
    },
    {
      "agent": "debugger",
      "task": "Fix the API test failure.",
      "write": true,
      "lockedPaths": ["apps/api/**"]
    }
  ]
}
```

This is allowed because:

```text
apps/web
apps/api
```

do not overlap.

This is rejected:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "write": true,
      "lockedPaths": ["apps/web/**"]
    },
    {
      "agent": "debugger",
      "write": true,
      "lockedPaths": ["apps/web/src/**"]
    }
  ]
}
```

because:

```text
apps/web
apps/web/src
```

overlap.

## 6. Lock Modes

### off

Use for read-only agents.

No lock is acquired.
Changed-file validation still detects if a read-only job edited files.

### simple

Use for one writer.

The MCP Bridge acquires one temporary write lock, runs the agent, validates changed files, and releases the lock.

### strict

Use for multiple parallel writers.

The bridge rejects overlapping normalized paths before execution.

## 7. Lock Recommendation

Normal workflow:

```text
Codex
-> run_opencode_agent(builder)
-> MCP acquires temporary lock
-> builder runs
-> MCP validates changed files
-> MCP releases lock
```

Do not use this as normal workflow:

```text
Codex
-> acquire_agent_lock
-> run_opencode_agent(builder)
-> release_agent_lock
```

If a manual lock already exists and a writer is called, the bridge returns:

```text
Manual lock already exists. Do not pre-acquire locks before run_opencode_agent.
```

## 8. Path Handling

The bridge normalizes common wildcard suffixes:

```text
apps/web/**          -> apps/web
packages/shared/**  -> packages/shared
apps/api/**          -> apps/api
apps/api/app/**      -> apps/api/app
README.md           -> README.md
```

It also normalizes Windows separators:

```text
apps\api\app\**\ -> apps/api/app
```

Rejected unsafe paths include:

- parent traversal such as `../outside`
- control characters
- home shortcuts such as `~/secret`

## 9. Changed-file Validation

For write agents, the bridge compares Git-detected changed files before and after the run.

It rejects results when:

- a write agent edits outside `allowedEdits`
- a read-only agent edits files
- forbidden files change
- shared/frozen files change
- serial-only/global files change during parallel execution
- multiple parallel jobs edit the same file
- OpenCode native fallback is detected
- OpenCode API errors are detected

Changed-file validation does not replace locks.

Locks prevent obvious MCP-managed write collisions before execution.
Changed-file validation catches violations after execution.

The safest model uses both.

## Queue and Worktrees

The queue and worktree layers add scalability without replacing existing safety layers:

```text
Queue schedules when a job can run.
Scope Contract defines what the job may read/write.
Worktree defines where the job runs.
Lock remains the MCP write-collision safety net.
Changed-file validation verifies the actual result.
Codex reviews and decides what to merge or apply.
```

Queue states:

```text
pending
planned
blocked
running
validating
reviewing
testing
completed
failed
cancelled
```

Read-only queued jobs can run in parallel. Write jobs with overlapping normalized write scopes wait by default. If `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY=reject`, conflicting queued write jobs fail immediately instead.

Git worktrees are optional and disabled by default. When `CODEX_OPENCODE_WORKTREE_MODE=write`, write jobs run in generated worktrees. When set to `all`, read-only jobs can also run there. The bridge still validates Scope Contracts, acquires locks for write jobs, checks changed files, rejects forbidden files, and returns worktree path, branch, changed files, diff stat, and a patch preview for Codex review.

## 10. Timeout and Retry Policy

Default timeouts:

```text
read-only agents: 3 minutes
write agents: 10 minutes
builder: 15 minutes
orchestrator: 20 minutes
```

Environment variables:

```text
CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS
CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS
CODEX_OPENCODE_BUILDER_TIMEOUT_MS
CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS
CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES
```

Read-only agents retry on timeout.

Default:

```text
maxRetries = 2
```

If a read-only agent still times out, it is marked unavailable and the rest of the orchestration can continue.

Write-agent timeouts are treated as execution failures.

## 11. Error Reporting

Every rejected execution includes:

```text
errorType
requestedAgent
actualAgent
reason
suggestedFix
lockMode
durationMs
conflictingPaths
```

Common error types:

```text
lock_plan_rejected
parallel_plan_rejected
agent_routing_error
manual_lock_conflict
write_lock_conflict
changed_file_validation_error
agent_timeout
opencode_native_fallback
opencode_api_error
read_only_agent_unavailable
queue_disabled
queue_job_failed
worktree_git_not_available
worktree_path_unsafe
worktree_create_failed
worktree_checkout_failed
worktree_changed_file_validation_error
worktree_cleanup_failed
worktree_merge_conflict
```

Lock conflict message:

```text
Write lock conflict on: <path>
```

Timeout message:

```text
Agent timeout: <agent>
```

## 12. Observability

Structured logs go to stderr.

They can include:

- agent
- command shape
- duration
- lockMode
- lockType
- retries
- exitCode
- timeout status

They must not include:

- prompts
- stdout
- stderr
- full environment variables
- API keys
- tokens
- secrets
- passwords

Logging level:

```text
CODEX_OPENCODE_LOG_LEVEL=off|error|warn|info|debug
```

Default:

```text
warn
```

## 13. Configuration

Useful environment variables:

```text
CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE=off
CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE=simple
CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE=strict
CODEX_OPENCODE_PARALLEL_LIMIT=6
CODEX_OPENCODE_LOG_LEVEL=warn
CODEX_OPENCODE_WORKTREE_MODE=off
CODEX_OPENCODE_WORKTREE_ROOT=.codex-worktrees
CODEX_OPENCODE_WORKTREE_CLEANUP=never
CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX=agent
CODEX_OPENCODE_QUEUE_MODE=memory
CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT=6
CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY=wait
CODEX_OPENCODE_QUEUE_READONLY_RETRIES=2
CODEX_OPENCODE_QUEUE_WRITE_RETRIES=0
```

Restart or reload the MCP server after changing `server.js` or environment variables.

The running Node process keeps the old loaded code until restart.

## 14. OpenCode Orchestrator

The OpenCode `orchestrator` agent is available as a direct target:

```text
opencode run --agent orchestrator
```

It should be used as:

1. Delegated executor for bounded tasks.
2. Backup orchestrator when Codex cannot continue.
3. Standalone orchestrator when OpenCode is launched directly.

While Codex is active, OpenCode `orchestrator` is not the primary authority.

Codex still performs final review.

## 15. Can OpenCode Orchestrator Spawn Writers?

The MCP Bridge controls work that enters OpenCode through MCP tools.

If Codex calls:

```text
run_opencode_agent(orchestrator)
```

the bridge sees only one OpenCode process: `orchestrator`.

If that orchestrator internally runs other writers outside the MCP Bridge, the bridge cannot enforce per-writer MCP locks inside that internal OpenCode behavior.

Recommendation:

- Use OpenCode `orchestrator` for bounded delegation.
- Use direct `builder` / `debugger` calls for write execution when Codex needs strict path ownership.
- Use `validate_delegation_plan` before risky or parallel work.

## 16. When Locks Are Actually Needed

Locks are not needed for:

- read-only agents
- Codex direct file edits
- one-side-only OpenCode work outside Codex/MCP

Locks are needed for:

- MCP-managed write agents
- multiple MCP-managed writers
- future scaling with parallel execution

Locks are most valuable before execution.
Changed-file validation is most valuable after execution.

## 17. Best Operating Model

Use this as the default:

```text
Read-only work:
Codex -> planner/reviewer/tester/architect
lockMode: off

One write task:
Codex -> validate_delegation_plan
Codex -> run_opencode_agent(builder/debugger)
lockMode: simple

Parallel write task:
Codex -> validate_delegation_plan
Codex -> run_opencode_parallel
lockMode: strict

Shared/risky task:
Run serially.
Then reviewer.
Then tester/validation.
```

## 18. Manual Test Examples

### Preflight one writer

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Implement only the web UI change.",
      "write": true,
      "lockedPaths": ["apps/web/**"]
    }
  ]
}
```

Expected:

```text
Delegation plan accepted.
```

### Preflight overlapping writers

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Edit web.",
      "write": true,
      "lockedPaths": ["apps/web/**"]
    },
    {
      "agent": "debugger",
      "task": "Edit web src.",
      "write": true,
      "lockedPaths": ["apps/web/src/**"]
    }
  ]
}
```

Expected:

```text
Delegation plan rejected.
errorType: parallel_plan_rejected
```

### Run builder correctly

```json
{
  "agent": "builder",
  "task": "Implement only apps/web.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/web/**"]
}
```

### Run reviewer correctly

```json
{
  "agent": "reviewer",
  "task": "Review the current diff. Do not edit files.",
  "lockMode": "off"
}
```

### Enqueue builder

```json
{
  "agent": "builder",
  "task": "Implement only apps/billing.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/billing/**"],
  "scope": {
    "read": ["apps/billing/**"],
    "write": ["apps/billing/**"],
    "forbidden": [".env", ".env.*", "package-lock.json"]
  }
}
```

Expected:

```text
OpenCode job enqueued.
```

Then inspect:

```json
{
  "jobId": "<returned job id>"
}
```

## 19. Automated Verification

Project test command:

```powershell
npm test
```

This runs:

```text
node --check server.js
node server.js --self-test
```

Self-tests cover:

- path normalization
- unsafe path rejection
- lock mode defaults
- single writer validation
- parallel writer validation
- overlap rejection
- read-only timeout handling
- structured error fields
- orchestrator timeout
- preflight validation
- Scope Contract validation
- queue enqueue, conflict detection, retry policy, and cancellation records
- Git worktree creation, preserve/cleanup behavior, and worktree changed-file validation
- dirty/untracked changed-file detection

## 20. Final Summary

The final architecture is intentionally simple:

```text
Codex decides.
MCP Bridge schedules, checks, and protects.
OpenCode agents execute bounded tasks.
MCP validates changed files.
Codex reviews and finalizes.
```

The best workflow is not more manual locks.

The best workflow is:

```text
Preflight when needed.
Run direct agents.
Use the queue when scheduling or conflict waiting is useful.
Use worktrees when write isolation is useful.
Use temporary MCP locks for writers.
Reject overlapping parallel writes.
Validate changed files.
Let Codex make the final call.
```
