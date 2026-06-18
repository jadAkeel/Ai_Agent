---
name: safe-implementation
description: Implement changes safely with minimal unnecessary edits. Use when the user asks to implement this, apply the plan, make the change, fix it safely, or perform code edits while preserving existing architecture, behavior, style, and tests.
---

# Safe Implementation

Make the smallest working change that fits the existing project.

## Rules

- Inspect relevant files before editing.
- Follow existing architecture, naming, formatting, and style.
- Keep diffs focused and small.
- Avoid unrelated refactors, cleanup, or formatting churn.
- Preserve behavior unless the change explicitly requires otherwise.
- Do not introduce dependencies unless clearly necessary and justified.
- Do not silently change public APIs, data contracts, or user-visible behavior.
- Do not remove tests, validation, or error handling unless explicitly approved.
- Explain important changes and tradeoffs.

## Output

Include:
- What changed
- Files changed
- Why it changed
- Tests run
- Remaining risks
- Next steps
