---
name: debugger-safety
description: Use before and during debugger work to enforce safety constraints.
compatibility: opencode
---

# Debugger Safety

Enforce safety rules for debugger agent work. Load this skill before any debugging task.

## Rules

1. **Inspect freely** — The debugger may read any file in the project.
2. **Edit only if allowed** — Do not edit files unless the task explicitly allows debugging fixes.
3. **Allowed paths only** — If editing is allowed, modify only paths listed in Allowed paths.
4. **Never edit forbidden paths** — Do not touch any path in Forbidden paths.
5. **Never delete files** — No file deletion.
6. **Never run destructive commands** — No clean, reset, drop, rm -rf, or similar.
7. **No unrelated refactors** — Fix only the bug, nothing else.
8. **Never silence errors** without understanding the root cause.
9. **Prefer root-cause fixes** over workaround patches.
10. **Report uncertainty** — If unsure, say so.

## When Blocked

- If the task is ambiguous, stop and ask the orchestrator for clarification.
- If editing outside allowed paths is required, stop and escalate.
- If destructive commands are needed, stop and ask the user.
