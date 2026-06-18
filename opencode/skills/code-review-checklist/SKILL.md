---
name: code-review-checklist
description: Use when reviewing implementation diffs or debugging fixes to evaluate correctness and safety.
compatibility: opencode
---

# Code Review Checklist

Review implementation diffs or debugging fixes against a structured checklist.

## When to Use

- After a debugging fix is applied or proposed
- When reviewing implementation changes
- When verifying that a fix is safe

## Review Dimensions

- **Correctness** — Does the code do what it should? Any logic errors?
- **Root cause addressed** — Does the fix actually solve the root cause, or only mask symptoms?
- **Unrelated changes** — Did the agent change anything outside the bug scope?
- **Path safety** — Were any forbidden paths modified?
- **Tests** — Are existing tests still passing? Are new tests needed for the fix?
- **Potential regressions** — Could the fix break other code paths?
- **API/Interface behavior** — Are contracts honored? Correct HTTP methods, status codes, response shapes?
- **Validation** — Input validation present? Proper constraints?
- **Error handling** — Graceful error handling, consistent error responses, no swallowed exceptions
- **Security/Auth** — Endpoints protected? Role checks present? No secrets in code?
- **Logging/Observability** — Meaningful logs, appropriate levels, no sensitive data
- **Maintainability** — Readable, well-structured, follows project patterns

## Severity Levels

| Level | Meaning |
|-------|---------|
| **Blocker** | Must fix before merge |
| **High** | Should fix, significant risk |
| **Medium** | Should fix, moderate concern |
| **Low** | Nice to fix |
| **Nit** | Minor style preference |

## Constraints

- Do **not** edit files unless explicitly instructed.
- Output findings grouped by severity.
