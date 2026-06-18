---
name: codex-handoff
description: create professional handoff summaries for codex, claude code, or coding-agent sessions so a fresh agent can continue work without the full chat history. use when the user asks for handoff, session transfer, continuation notes, compact-style project summary, next-agent prompt, or wants to preserve coding context before starting a new session.
---

# Codex Handoff

## Purpose

Generate a clean handoff note that lets a fresh Codex or coding-agent session continue from the current work without needing the full conversation history.

Use this skill to produce a structured, practical transfer document. Prefer concrete repo facts, file paths, commands, test results, decisions, risks, and next actions over generic summaries.

## Workflow

1. Identify what context is available:
   - Conversation history and user instructions.
   - Any visible repository state, file changes, command outputs, plans, or test results.
   - Any assumptions that still need verification.

2. Separate facts from assumptions:
   - Mark repo facts as verified only when directly observed.
   - Mark uncertain details as `needs verification`.
   - Do not invent branch names, files changed, test results, or implementation details.

3. Produce the handoff using the default template below.

4. End with a ready-to-paste first prompt for the next session.

## Default Output Template

Use this structure unless the user asks for a shorter or different format.

```markdown
# Handoff Summary

## 1. Project / Repository Context
- Project purpose:
- Main stack / framework:
- Important architecture notes:
- Relevant conventions:

## 2. Current Goal
- Goal:
- Why it matters:
- Definition of done:

## 3. Work Completed So Far
- Files inspected:
- Files changed:
- Main decisions made:
- Important implementation details:

## 4. Current Repository State
- Branch:
- Uncommitted changes:
- Generated files:
- Config, migration, dependency, or environment changes:
- Items that need verification:

## 5. Commands Run
| Command | Purpose | Result | Status |
|---|---|---|---|
| `[command]` | [why it was run] | [short result] | passed/failed/unknown |

## 6. Tests / Verification
- Tests run:
- Manual checks done:
- What passed:
- What still needs verification:

## 7. Known Issues / Risks
- Bugs found:
- Edge cases:
- Broken or skipped tests:
- Unclear assumptions:
- Things that must not be changed:

## 8. Remaining TODOs
1. [highest priority next step]
2. [next step]
3. [next step]

## 9. Constraints / Rules for the Next Agent
- Preserve existing behavior unless explicitly required.
- Avoid unrelated refactors.
- Follow existing code style and architecture.
- Inspect relevant files before editing; do not rely only on this summary.
- Run relevant tests before finishing.
- Explain risky changes before applying them.

## 10. Suggested First Prompt for the Next Session
```text
Continue from this handoff summary.

First verify the current repository state and compare it with the summary. Then continue with the remaining TODOs in order.

Do not assume the summary is perfectly up to date. Inspect the relevant files before editing. Preserve existing behavior unless a change is explicitly required.

[PASTE HANDOFF SUMMARY HERE]
```
```

## Compact Handoff Mode

When the user asks for a short handoff, use this format:

```markdown
# Compact Handoff

## Goal
[one paragraph]

## Done
- [fact]
- [fact]

## Changed / Relevant Files
- `path`: [what matters]

## Commands / Tests
- `[command]`: [result]

## Risks
- [risk or `none known`]

## Next Steps
1. [step]
2. [step]

## Next Prompt
```text
Continue from this handoff. Verify repo state first, then complete the next steps.

[PASTE COMPACT HANDOFF HERE]
```
```

## Quality Rules

- Prefer exact file paths, command names, and observed results.
- Use `unknown` or `needs verification` instead of guessing.
- Keep the handoff actionable enough that a new agent can start immediately.
- Include only useful context; omit chatty conversation details.
- Preserve user constraints, coding standards, and decisions that should affect future work.
- If no repo details are available, produce a prompt-template handoff and clearly mark missing sections as `needs verification`.
- For long sessions, group related changes by feature or area instead of listing every small message.

## User-Facing Shortcut

When the user says something like `make a handoff`, `handoff this session`, or `prepare next codex session`, generate the handoff directly. Do not ask follow-up questions unless the missing information would make the handoff unsafe or unusable.
