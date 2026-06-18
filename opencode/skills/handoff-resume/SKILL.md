---
name: handoff-resume
description: Use when creating or updating a continuation handoff, or when resuming interrupted work.
compatibility: opencode
---

# Handoff Resume

Create, update, or resume from a structured handoff for multi-session coding work.

## Creating a Handoff

When creating or updating a handoff, include:

| Section | Content |
|---------|---------|
| **Current goal** | What is being worked on |
| **Approved plan summary** | Link or summary of the approved plan |
| **Completed tasks** | Tasks that are done |
| **In-progress tasks** | Tasks currently being worked on |
| **Blocked tasks** | Tasks blocked and why |
| **Files changed** | All files modified so far |
| **Commands/tests run** | What was executed and results |
| **Known risks** | Open issues or concerns |
| **Latest checkpoint** | Path to the latest checkpoint |
| **Next safe action** | The exact next step to take |
| **Continue prompt** | An exact prompt that can be used in a fresh session to continue |

## Resuming from a Handoff

When resuming work from a prior session, read these files in order:

1. `.orchestrator/handoff.md` — Current state and next action
2. `.orchestrator/task-map.md` — Task status overview
3. `.orchestrator/execution-log.md` — Full history
4. Latest checkpoint (from `checkpoints/`) — Snapshot of key files

After reading, confirm understanding and continue from the last safe point. Do not redo completed work.
