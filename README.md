# Codex OpenCode MCP Bridge

This bridge lets Codex call OpenCode agents through MCP while keeping Codex as the orchestrator.

After changing `server.js`, restart or reload the MCP server process before relying on live MCP tool output. The running Node process keeps the previously loaded bridge code until it is restarted.

## Repository Contents

This repo is also a safe backup of the important non-secret global setup files:

- `codex/agents/`: current Codex orchestrator and subagent configs.
- `codex/skills/`: custom Codex skills, excluding bundled/system skills.
- `codex/config.example.toml`: sanitized MCP config example.
- `opencode/agents/`: current OpenCode agent configs.
- `opencode/skills/`: current OpenCode skills, excluding backups.
- `opencode/opencode.jsonc`: sanitized OpenCode config reference.
- `docs/`: architecture goals and safe publish manifest.

Sensitive runtime files are intentionally excluded. See `docs/SAFE_PUBLISH_MANIFEST.md`.

## Architecture Overview

The bridge implements this global workflow:

```text
User
-> Codex
-> MCP Bridge
-> OpenCode CLI
-> OpenCode agents
```

Codex remains the primary orchestrator. The MCP bridge is the execution and safety boundary: it resolves the requested OpenCode agent, builds a compact task packet, applies temporary write locks when needed, runs `opencode run --agent <agent>`, captures duration and exit status, checks for OpenCode fallback/API errors, validates detected changed files, releases temporary locks, and returns the result to Codex for review.

OpenCode is the execution backend. OpenCode agents should receive bounded tasks with explicit scope, allowed edits, forbidden edits, and validation expectations. The global `orchestrator` agent can be used as a delegated executor or backup orchestrator, but Codex is still responsible for final review when Codex is active.

The OpenCode `orchestrator` is read-only by default when invoked through this bridge. If Codex passes `write: true` with bounded `lockedPaths` and `allowedEdits`, the bridge automatically treats it as a bounded writer for one isolated service folder. The bridge rejects nested writer delegation because internal builders would bypass MCP per-writer locks.

For risky or parallel work, use `validate_delegation_plan` before execution:

```text
Codex
-> validate_delegation_plan
-> run_opencode_agent or run_opencode_parallel
-> MCP validation
-> Codex review
```

The preflight tool does not run OpenCode agents and does not acquire locks. It validates the same path, lock, timeout, parallel-overlap, active-lock, and agent-routing rules used by execution tools.

## Agent Routing

`run_opencode_agent` requests the named OpenCode agent when it exists:

```text
planner   -> opencode run --agent planner <prompt>
reviewer  -> opencode run --agent reviewer <prompt>
tester    -> opencode run --agent tester <prompt>
builder   -> opencode run --agent builder <prompt>
debugger  -> opencode run --agent debugger <prompt>
architect -> opencode run --agent architect <prompt>
orchestrator -> opencode run --agent orchestrator <prompt>
build     -> opencode run --agent build <prompt>
```

The bridge checks OpenCode agent availability before running. It does not silently route all requests through `build`.

The expected global delegation roles (`planner`, `reviewer`, `tester`, `builder`, `debugger`, `architect`, and `orchestrator`) should be configured as runnable OpenCode agents, usually `mode: all`, so direct CLI routing is the normal path.

If OpenCode reports native fallback after a direct run, the bridge reports that result as rejected because the requested role may not have executed. Results always report:

- requested agent and mode
- actual OpenCode agent used
- fallback status and reason, when fallback was explicitly allowed
- whether subagent proxying was used
- whether native OpenCode fallback was detected
- whether OpenCode returned an API error event

`subagentStrategy: "proxy"` remains available for true OpenCode subagents that are intentionally not runnable as primary/all agents. In that mode, the bridge runs a primary/all OpenCode agent, `build` by default, and injects the requested subagent definition into the prompt.

Use `subagentStrategy: "reject"` when you want the bridge to fail instead of proxying subagents.

Example reviewer call:

```json
{
  "agent": "reviewer",
  "task": "Review this diff. Do not edit files."
}
```

## Delegation Preflight

`validate_delegation_plan` checks whether a single or parallel OpenCode delegation plan is safe before running it.

It verifies:

- direct agent routing and explicit fallback behavior
- normalized lock paths
- read/write lock modes
- missing or unsafe paths
- allowed edit paths staying inside locked paths
- parallel write overlap
- active lock conflicts
- effective timeout for each job

Accepted plans report the execution mode, planned command shape, actual agent, lock mode, lock type, normalized locked paths, allowed edits, timeout, and queue status. Rejected plans use the same structured error fields as execution failures.

Example preflight for one writer:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Implement only the web UI change.",
      "write": true,
      "lockedPaths": ["apps/web/**"],
      "allowedEdits": ["apps/web/**"]
    }
  ]
}
```

Example preflight for parallel writers:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Edit web.",
      "write": true,
      "lockedPaths": ["apps/web/**"],
      "allowedEdits": ["apps/web/**"]
    },
    {
      "agent": "debugger",
      "task": "Edit api.",
      "write": true,
      "lockedPaths": ["apps/api/**"],
      "allowedEdits": ["apps/api/**"]
    }
  ]
}
```

## Job Queue and Git Worktrees

The bridge includes an optional lightweight queue for scheduled OpenCode work:

```text
Codex
-> enqueue_opencode_job
-> MCP Queue
-> Scope Contract validation
-> lock/conflict check
-> optional Git worktree
-> OpenCode agent
-> changed-file validation
-> Codex review
```

Direct `run_opencode_agent` and `run_opencode_parallel` still work. The queue is for scalable scheduling, status tracking, cancellation, and serializing conflicting writers.

Queue tools:

- `enqueue_opencode_job`: enqueue one job using the same safety checks as `run_opencode_agent`.
- `list_opencode_jobs`: list queued/running/completed jobs.
- `get_opencode_job`: retrieve one job and its result text.
- `cancel_opencode_job`: cancel pending/blocked jobs, or request cancellation for running jobs.

Read-only jobs can run in parallel. Write jobs with overlapping normalized edit scopes wait by default, or fail immediately when `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY=reject`.

Git worktrees are off by default. When enabled with `CODEX_OPENCODE_WORKTREE_MODE=write` or `all`, eligible jobs run inside generated Git worktrees. Locks still apply, Scope Contracts still apply, and changed-file validation runs against the worktree result. The bridge returns the worktree path, branch, changed files, diff stat, and a patch preview for Codex review.

Example queued builder:

```json
{
  "agent": "builder",
  "task": "Implement only the billing service.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/billing/**"],
  "scope": {
    "read": ["apps/billing/**", "packages/ui/**"],
    "write": ["apps/billing/**"],
    "forbidden": [".env", ".env.*", "package-lock.json"]
  }
}
```

## Fallback Behavior

Missing-agent fallback to `build` is disabled by default. If an agent is missing, the tool returns a clear routing error.

Set `allowFallbackToBuild: true` only when `build` is an acceptable fallback. Results always report the requested agent, actual agent, whether fallback was used, and the fallback reason.

## Configuration

Behavior can be tuned with environment variables before the MCP server starts:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS` | `180000` | Timeout for planner, architect, reviewer, tester, and other read-only jobs. |
| `CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS` | `600000` | Default timeout for write jobs. |
| `CODEX_OPENCODE_BUILDER_TIMEOUT_MS` | `900000` | Builder-specific timeout. |
| `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS` | `1200000` | OpenCode orchestrator timeout. |
| `CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES` | `2` | Retry count for read-only timeouts. |
| `CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE` | `off` | Default lock mode for read-only jobs. |
| `CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE` | `simple` | Default lock mode for a single writer. |
| `CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE` | `strict` | Default lock mode for multiple parallel writers. |
| `CODEX_OPENCODE_PARALLEL_LIMIT` | `6` | Maximum jobs accepted by `run_opencode_parallel`. |
| `CODEX_OPENCODE_LOG_LEVEL` | `warn` | Structured stderr logging level: `off`, `error`, `warn`, `info`, or `debug`. |
| `CODEX_OPENCODE_WORKTREE_MODE` | `off` | Worktree mode: `off`, `write`, or `all`. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `.codex-worktrees` | Root directory for generated Git worktrees. |
| `CODEX_OPENCODE_WORKTREE_CLEANUP` | `never` | Cleanup policy: `always`, `on_success`, or `never`. |
| `CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX` | `agent` | Branch prefix for generated worktree branches. |
| `CODEX_OPENCODE_QUEUE_MODE` | `memory` | Queue storage mode: `off`, `memory`, or `sqlite`. |
| `CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT` | `6` | Maximum queued jobs running at once. |
| `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY` | `wait` | Queue write conflict policy: `wait` or `reject`. |
| `CODEX_OPENCODE_QUEUE_READONLY_RETRIES` | `2` | Queue-level retry count for safe read-only jobs. |
| `CODEX_OPENCODE_QUEUE_WRITE_RETRIES` | `0` | Queue-level retry count for write jobs. |

Structured logs never include prompts, stdout, stderr, full environment variables, tokens, API keys, secrets, or passwords. At `info` level, successful OpenCode runs log agent, command shape, duration, lock mode, retry count, exit code, timeout status, and dry-run status. Warnings are emitted for timeouts, non-zero exits, API error events, and native OpenCode fallback detection.

## Compact Delegation Packets

Callers can pass `delegation` fields to avoid sending large conversation history:

```json
{
  "agent": "planner",
  "task": "Create a focused implementation plan.",
  "delegation": {
    "scope": ["src/auth/**"],
    "allowedEdits": [],
    "forbiddenEdits": ["package.json", "shared/**"],
    "sharedFiles": ["shared/types.ts"],
    "permissions": "read-only / bash ask"
  }
}
```

The bridge formats these fields as a small task contract with a fixed return format.

Use this compact task packet shape instead of sending full chat history:

```text
Role: <agent>

Task: <bounded task>

Scope:
<files/directories/modules, or "current repo">

Allowed edits:
<paths or "none">

Forbidden edits:
<paths or "none specified">

Shared files: <shared files frozen unless explicitly assigned>

Permissions:
<read-only / write allowed / bash ask / bash allowed>

Return format:

1. Summary
2. Files inspected
3. Files changed
4. Changes made or proposed
5. Risks
6. Validation performed
7. Validation still recommended
```

## Safe Parallel Writes

`run_opencode_parallel` applies the same agent-routing rules as `run_opencode_agent`. Subagents are proxied by default so OpenCode does not silently fall back to a default primary agent. Read-only jobs can run in parallel by default.

These lock rules apply to Codex-delegated work that enters OpenCode through this MCP bridge. In that flow, the MCP bridge creates temporary locks for write agents, OpenCode agents cannot grant locks to themselves, and write agents may edit only paths explicitly granted by the run call.

When OpenCode is launched directly without Codex/MCP, temporary OpenCode subagents do not wait for Codex locks. The standalone OpenCode orchestrator should manage local scoped ownership internally when parallel writes are needed, or run work serially when ownership is unclear.

## OpenCode Orchestrator Large Task Mode

Codex may delegate a large task to the OpenCode `orchestrator` through Large Task Mode. Codex remains the authority, the MCP bridge infers the safe mode from the request, protects scope, validates changed files, and Codex reviews the final result.

`orchestratorMode` is optional. The bridge infers it automatically:

- no write scope: `planning-only`
- `write: true` with bounded `lockedPaths` and `allowedEdits`: `bounded-writer`

Codex may still pass `orchestratorMode` explicitly when it wants to be strict.

Modes:

- `planning-only`: OpenCode orchestrator does not write files. It returns architecture, task breakdown, expected files, proposed `allowedEdits`, risks, test plan, and follow-up builder/debugger jobs for Codex to run through MCP.
- `bounded-writer`: OpenCode orchestrator may write as one single bounded writer inside an isolated service folder only.

Use policy:

- Small feature: Codex uses `builder` or `debugger` directly through MCP Bridge.
- Large isolated service: Codex may use OpenCode `orchestrator` as `bounded-writer` inside a folder such as `apps/billing/**`.
- Large service touching shared/global files: OpenCode `orchestrator` must run `planning-only`; Codex then distributes implementation to direct `builder`/`debugger` jobs through MCP Bridge.

Planning-only example:

```json
{
  "agent": "orchestrator",
  "task": "Plan the complete billing service architecture. Return affected files, allowedEdits proposal, risks, and test plan.",
  "lockMode": "off"
}
```

Bounded-writer example:

```json
{
  "agent": "orchestrator",
  "task": "Build the isolated billing service only inside apps/billing. Do not run internal builders.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/billing/**"],
  "allowedEdits": ["apps/billing/**"]
}
```

Bounded-writer rules:

- must be a single `run_opencode_agent` call
- must use `write: true`
- must use `lockMode: "simple"`
- must provide non-empty `lockedPaths`
- must provide non-empty `allowedEdits`
- must not run, spawn, invoke, or delegate to internal builders, debuggers, writers, or parallel subagents
- must not touch root configs, lockfiles, env files, shared packages, or other global/risky paths

If the task touches global/shared files, use planning-only first, then let Codex run direct writer jobs through MCP.

## Temporary Write Locks

For MCP-delegated work, the bridge keeps active locks in a local SQLite registry:

```text
<workspace>/.mcp/bridge-state.sqlite
```

If no safe workspace root is available, the bridge uses the global bridge state directory under `%USERPROFILE%\.codex\codex-opencode-mcp`.

The SQLite registry uses WAL mode and token-based temporary locks. Lock release is allowed only when both the run id and lock token match, so an old run cannot release a newer lock.

Available lock tools:

- `acquire_agent_lock`: exceptional/debug manual coordination only.
- `release_agent_lock`: exceptional/debug manual cleanup only.
- `list_agent_locks`: list active, non-expired locks.

Manual acquire/release is not the normal workflow. Do not call `acquire_agent_lock` or `release_agent_lock` before calling `builder`, `debugger`, or another write agent.

The normal write workflow is:

```text
Codex
-> run_opencode_agent(builder)
-> MCP acquires temporary lock
-> builder runs
-> MCP validates changed files
-> MCP releases lock
```

`run_opencode_agent` and `run_opencode_parallel` acquire and release temporary write locks automatically. Write-capable OpenCode jobs called through MCP are rejected before start unless the run call provides both `lockedPaths` and `allowedEdits`.

`lockedPaths` define coarse lock ownership. `allowedEdits` define the exact file or directory allowlist for changed-file validation. The bridge validates the resulting Git diff against `allowedEdits`, not only `lockedPaths`.

Lock modes:

- `off`: read-only agents such as planner, architect, reviewer, and tester.
- `simple`: one write agent with one bounded edit zone.
- `strict`: multiple parallel write agents with non-overlapping edit zones.

If a lock conflict exists, the bridge returns a short error:

```text
Write lock conflict on: <path>
```

If a manual lock already exists and a write agent is invoked through `run_opencode_agent`, the bridge returns:

```text
Manual lock already exists. Do not pre-acquire locks before run_opencode_agent.
```

Codex direct file edits do not require MCP locks. MCP locks coordinate OpenCode agents launched through this bridge.

Timeout defaults:

- read-only agents: `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS`, default 3 minutes.
- write agents: `CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS`, default 10 minutes.
- builder: `CODEX_OPENCODE_BUILDER_TIMEOUT_MS`, default 15 minutes.
- orchestrator: `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS`, default 20 minutes.
- read-only retries: `CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES`, default 2 retries.

If a read-only agent still times out after retries, it is marked unavailable and the rest of the parallel orchestration can continue.

If a non-read-only agent times out, the result includes:

```text
Agent timeout: <agent>
```

Supported lock types:

- `read`: for planner, architect, reviewer, tester, exploration, review, planning, and no-edit validation. Read-only agents never require locks.
- `write`: for builder, debugger, and other implementation agents.
- `serial_integration`: for single serial write steps. This lock is rejected by `run_opencode_parallel`.

Write-capable jobs require:

- `lockedPaths`
- `allowedEdits`

Optional fields:

- `lockType: "write"`; inferred when `write: true`
- `ownedPaths`; backward-compatible alias for `lockedPaths`
- `forbiddenEdits`
- `sharedFiles`
- `validationCommand`

New callers should use `lockedPaths`.

Wildcard suffixes are normalized before validation:

```text
apps/web/**          -> apps/web
packages/shared/**  -> packages/shared
apps/api/**          -> apps/api
apps/api/app/**      -> apps/api/app
apps\api\app\**\     -> apps/api/app
README.md           -> README.md
```

Path inputs that contain parent traversal, control characters, or home-directory shortcuts are rejected before execution.

If only one write agent is running, the bridge allows execution immediately after acquiring its temporary lock. Strict overlap checks are enforced when multiple write agents run in parallel.

For parallel writes, each write job must provide `lockedPaths` and `allowedEdits`. `allowedEdits` must stay inside `lockedPaths`. Parallel write jobs with overlapping normalized locks are rejected before execution.

Write-capable parallel jobs must include:

- `agent`
- `task`
- `lockedPaths`
- `allowedEdits`

Example builder call:

```json
{
  "agent": "builder",
  "task": "Implement only the web UI change.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/web/**"],
  "allowedEdits": ["apps/web/**"],
  "dryRun": true
}
```

The bridge normalizes this to `apps/web`, acquires the temporary lock internally, and routes directly to:

```text
opencode run --agent builder
```

Example debugger call:

```json
{
  "agent": "debugger",
  "task": "Fix the failing shared package test only.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["packages/shared/**"],
  "allowedEdits": ["packages/shared/**"],
  "dryRun": true
}
```

Example planner call:

```json
{
  "agent": "planner",
  "task": "Plan the auth refactor. Do not edit files.",
  "lockMode": "off",
  "dryRun": true
}
```

Example reviewer call:

```json
{
  "agent": "reviewer",
  "task": "Review the current diff. Do not edit files.",
  "write": false,
  "lockMode": "off",
  "dryRun": true
}
```

Planner, architect, reviewer, and tester are read-only by default and do not require locks.

Example overlapping parallel write rejection:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Edit web app.",
      "write": true,
      "lockMode": "strict",
      "lockedPaths": ["apps/web/**"],
      "allowedEdits": ["apps/web/**"]
    },
    {
      "agent": "debugger",
      "task": "Edit web components.",
      "write": true,
      "lockMode": "strict",
      "lockedPaths": ["apps/web/src/**"],
      "allowedEdits": ["apps/web/src/**"]
    }
  ]
}
```

The bridge normalizes the locks to `apps/web` and `apps/web/src`, detects overlap, and rejects before execution.

What not to do:

```json
{
  "tool": "acquire_agent_lock",
  "paths": ["apps/web/**"]
}
```

Do not manually acquire a lock and then call `builder`. Use one `run_opencode_agent` call with `lockMode: "simple"`, `lockedPaths`, and `allowedEdits`.

Every write task packet sent to OpenCode includes:

```text
Lock mode: simple

Lock type: write

Lock granted:
<paths>

Allowed edits:
<paths>

Forbidden edits:
<paths>

Shared files frozen: <paths>

If you need files outside the lock:
Do not edit them. Return NEEDS_INTEGRATION with the file/path needed, reason, and recommended change.
```

After each write agent finishes, it must report the lock used, files inspected, files changed, files it wanted but did not edit, validation performed, and risks.

After all parallel jobs finish, the bridge checks detected changed files and rejects the combined result when:

- a read-only job changed files
- a write job changed files outside `allowedEdits`
- a forbidden or shared/frozen file changed
- a serial-only/global file changed
- multiple jobs changed the same file
- OpenCode native subagent fallback was detected
- OpenCode returned an API error event

Changed-file detection compares content snapshots for all Git-detected dirty and untracked files before and after each job. This catches additional edits to files that were already dirty or untracked before the agent started, instead of only noticing newly added filenames.

Before each write agent runs, the bridge captures a rollback baseline for already-dirty files. When changed-file validation fails, it attempts to roll back only the files introduced or modified by that run. Pre-existing dirty user work is restored to its pre-agent content when possible. Newly created disallowed files are removed. Deleted disallowed tracked files are restored from Git when possible.

The result reports:

- `rollback: success | partial | failed | not_needed`
- `disallowedFiles`
- `rollbackFiles`
- `unresolvedFiles`

If rollback is partial or failed, inspect `unresolvedFiles` before continuing.

## Serial-Only Paths

Some files and directories are global/risky and cannot be edited during parallel execution. Examples include package files, lockfiles, root config files, `.env*`, `README.md`, route trees, database migrations, and `prisma/schema.prisma`.

If a parallel write job's `lockedPaths` or `allowedEdits` overlaps a serial-only path, the bridge rejects before execution with:

```text
errorType: serial_only_path_in_parallel
reason: This file or path is global/risky and cannot be edited during parallel execution.
suggestedFix: Run this task serially, then run reviewer/tester validation.
```

Serial-only paths are allowed only in a single serial write job with explicit `allowedEdits`.

## Error Handling

Every rejected execution includes these fields:

```text
errorType: <classification>
requestedAgent: <requested agent>
actualAgent: <actual agent or none>
reason: <why it failed>
suggestedFix: <next action>
lockMode: <off/simple/strict/unknown>
durationMs: <elapsed time>
conflictingPaths: <paths or none>
lockedPaths: <paths, when relevant>
allowedEdits: <paths, when relevant>
runId: <SQLite lock run id, when relevant>
rollback: <success/partial/failed/not_needed, when relevant>
disallowedFiles: <paths, when relevant>
serialOnlyMatches: <paths, when relevant>
rollbackFiles: <paths, when relevant>
unresolvedFiles: <paths, when relevant>
```

Common `errorType` values:

- `lock_plan_rejected`
- `missing_locked_paths`
- `missing_allowed_edits`
- `invalid_write_lock_mode`
- `orchestrator_write_forbidden`
- `orchestrator_large_task_requires_mode`
- `orchestrator_bounded_writer_missing_scope`
- `orchestrator_internal_writer_forbidden`
- `orchestrator_global_file_requires_planning_only`
- `serial_only_path_in_parallel`
- `unsafe_path`
- `read_only_edit_forbidden`
- `agent_routing_error`
- `manual_lock_conflict`
- `write_lock_conflict`
- `parallel_plan_rejected`
- `changed_file_validation_error`
- `agent_timeout`
- `opencode_native_fallback`
- `opencode_api_error`
- `read_only_agent_unavailable`
- `queue_disabled`
- `queue_job_failed`
- `worktree_git_not_available`
- `worktree_path_unsafe`
- `worktree_create_failed`
- `worktree_checkout_failed`
- `worktree_changed_file_validation_error`
- `worktree_cleanup_failed`
- `worktree_merge_conflict`

Troubleshooting quick checks:

- After editing `server.js`, restart the MCP server before retesting live tools.
- For write agents, pass `write: true`, `lockedPaths`, and `allowedEdits`; do not call `acquire_agent_lock` first.
- For read-only agents, use `lockMode: "off"` or omit lock fields.
- If a parallel call is rejected, normalize the ownership zones and remove overlaps before retrying.
- If a parallel call touches package files, lockfiles, root configs, routes, migrations, or README, run that step serially.
- If OpenCode reports fallback, make the requested agent `mode: all` or explicitly choose a proxy strategy.
- If an agent times out, raise the relevant timeout env var or reduce the delegated task scope.

## Two-Phase Execution Model

For non-trivial write work:

1. Run isolated implementation jobs in parallel only when ownership zones do not overlap.
2. Run one serial integration step for shared contracts, package files, migrations, generated files, and cross-module wiring.
3. Run one review step and one validation step over the combined result.

## Global OpenCode Orchestrator

The global `orchestrator` agent is a backup and delegation target, not the default leader while Codex is active.

When called through MCP without a write scope, the OpenCode `orchestrator` is limited to bounded read-only planning, coordination, and analysis. When Codex provides `write: true`, `lockMode: "simple"`, `lockedPaths`, and `allowedEdits`, the bridge infers bounded-writer mode automatically; Codex still performs the final review.

It supports three modes:

1. Delegated Executor: follow compact Codex task packets through MCP.
2. Backup Orchestrator: continue from a handoff when Codex cannot continue.
3. Standalone Orchestrator: inspect the current repository when OpenCode is launched directly.

It is repo-agnostic. It must not create repo-local `.opencode/` directories or initialize Spec Kit unless explicitly asked.

## HANDOFF_TO_OPENCODE

When Codex cannot continue, provide OpenCode with this handoff:

```text
HANDOFF_TO_OPENCODE

1. Original goal
2. Current working directory
3. Current repo state
4. Codex plan
5. Completed work
6. Remaining work
7. Files changed
8. Commands run
9. Validation result
10. Risks
11. Next recommended task
```

OpenCode's global orchestrator can continue from this handoff in any repository.
