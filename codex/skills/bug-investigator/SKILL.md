---
name: bug-investigator
description: Investigate bugs before applying fixes. Use when the user asks to investigate this bug, find the root cause, why is this failing, debug this issue, inspect failing tests, stack traces, logs, runtime errors, or broken behavior before changing code.
---

# Bug Investigator

Investigate before fixing. Do not jump directly to code changes.

## Workflow

1. Capture the symptom, expected behavior, actual behavior, and reproduction steps.
2. Inspect logs, stack traces, failing tests, recent diffs, and related code.
3. Build hypotheses and confirm or reject them with evidence.
4. Identify the root cause, not just the nearest symptom.
5. Propose the smallest safe fix.
6. Prefer a regression test that fails before the fix and passes after it.
7. Edit only after root cause is clear or the user approves proceeding.

## Output

Include:
- Symptom
- Reproduction info
- Evidence found
- Root cause
- Minimal fix proposal
- Files affected
- Verification plan
- Risks
