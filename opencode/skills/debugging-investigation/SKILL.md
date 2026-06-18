---
name: debugging-investigation
description: Use when investigating a bug, crash, broken behavior, failing command, runtime issue, or unexpected output.
compatibility: opencode
---

# Debugging Investigation

Investigate bugs, crashes, broken behavior, and runtime issues. This skill is used by the debugger agent.

## When to Use

- Runtime bugs and crashes
- Broken behavior or unexpected output
- Failing commands or scripts
- Configuration issues
- Integration failures

## Investigation Workflow

1. **Reproduce or understand** the failure before proposing any changes.
2. **Gather symptoms**: What is happening vs what should happen.
3. **Collect evidence**: Logs, stack traces, error messages, recent changes, affected files.
4. **Inspect relevant code paths** before editing.
5. **Identify likely root causes** with supporting evidence.
6. **Distinguish evidence from assumptions** — label each claim.
7. **Do not make broad refactors** — stay focused on the bug.

## Debugging Report

Output:

- **Symptoms**: What is observed
- **Reproduction steps**: How to reproduce
- **Suspected root cause**: What likely causes the issue
- **Files inspected**: All files reviewed
- **Evidence**: Logs, traces, diffs, test output
- **Recommended fix**: Minimal change to address root cause
- **Risk level**: Low / Medium / High / Critical
