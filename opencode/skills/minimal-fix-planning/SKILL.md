---
name: minimal-fix-planning
description: Use before applying a bug fix to plan the smallest safe change.
compatibility: opencode
---

# Minimal Fix Planning

Plan the smallest safe fix before applying any change. This skill is used by the debugger agent before editing files.

## When to Use

- Before applying any bug fix
- Before editing files during debugging
- When proposing a fix for review

## Planning Workflow

1. **Propose the smallest safe fix** that addresses the root cause.
2. **Avoid unrelated refactors** — fix only what is broken.
3. **Preserve existing behavior** for all other code paths.
4. **Identify allowed paths** and **forbidden paths**.
5. **Identify tests to run** after the fix is applied.
6. **If the fix requires touching shared/high-risk files**, stop and ask the orchestrator for approval.
7. **Consider edge cases** — does the fix handle null, empty, error states?

## Output

- **Proposed fix**: Description of what to change
- **Affected files**: Files to modify
- **Risk**: Low / Medium / High
- **Validation plan**: Commands to run after the fix
