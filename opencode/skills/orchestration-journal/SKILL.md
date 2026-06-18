---
name: orchestration-journal
description: Use when orchestrating medium, large, or multi-agent work and persistent history is required.
compatibility: opencode
---

# Orchestration Journal

Persist all orchestration state into `.orchestrator/` files. This skill is loaded when an agent is tasked with coordinating multi-agent or multi-phase work.

## Mandatory Files

Maintain the following files under `.orchestrator/`:

| File | Purpose |
|------|---------|
| `README.md` | Overview of the orchestration approach |
| `project-context.md` | High-level context, goals, constraints |
| `approved-plan.md` | The approved plan from architecture review |
| `task-map.md` | Current status of all tasks (pending, in-progress, completed, blocked) |
| `execution-log.md` | Chronological log of all actions taken |
| `handoff.md` | Resumable summary for continuation |
| `agent-reports/` | Reports from sub-agents, one file per report |
| `checkpoints/` | Named checkpoints after major phases |

## Rules

1. **Read first** — Before making changes, read existing `.orchestrator/` files if present.
2. **Log after every phase** — Update `execution-log.md` after meaningful steps.
3. **Save agent reports** — After receiving any sub-agent report, save it under `agent-reports/<agent>-<timestamp>.md`.
4. **Checkpoint major phases** — Copy key files into `checkpoints/<checkpoint-name>/` after completing a major milestone.
5. **Keep handoff.md resumable** — `handoff.md` must always contain enough context for a fresh session to pick up.
6. **No secrets** — Never store API keys, passwords, tokens, credentials, or machine-specific paths.
7. **Journal completeness** — Do not claim work is complete until the journal is updated.
