---
name: pr-and-commit-writer
description: Create professional commit messages and PR descriptions from the current diff. Use when the user asks to write a PR description, create commit message, summarize this diff, prepare this for review, or produce release-quality change summaries with implementation details, tests, risks, rollback notes, and reviewer notes.
---

# PR and Commit Writer

Write from the actual diff. Do not invent work, tests, or results.

## Workflow

1. Inspect the current diff and relevant file status before writing.
2. Identify the user-visible purpose and implementation details.
3. List tests and checks exactly as observed.
4. Use `Not run` or `Not verified` when appropriate.
5. Note risks, rollback considerations, and reviewer focus areas.

## Output

Include:
- Suggested commit message
- PR title
- PR summary
- Implementation details
- Tests run
- Risks / rollback notes
- Reviewer notes
