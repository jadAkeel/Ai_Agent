---
name: handoff-summary
description: create compact coding-session handoff summaries for another agent or future session. use when the user asks for a handoff, compact summary, continuation notes, session transfer, next-agent prompt, or wants to preserve coding context before switching agents or starting a new session.
---

# Handoff Summary Skill

Create a concise but complete handoff summary so another coding agent can continue work without needing the full conversation history.

## Rules

- Do not edit files.
- Do not run commands unless explicitly asked.
- Summarize only useful continuation context.
- Preserve concrete file paths, commands, test results, decisions, blockers, and next steps.
- Avoid vague status text.
- Be concise but complete.
- Write the handoff as something the next agent can act on immediately.

## What to include

Always include:

- Project goal
- Current task
- Current state
- Files changed or investigated
- Commands/tests run and results
- Known issues or blockers
- Decisions made
- Next steps
- Important constraints or assumptions

## Output format

# Handoff Summary

## Project Goal

## Current Task

## Current State

## Files Changed or Investigated

## Commands / Tests Run

## Results

## Known Issues / Blockers

## Decisions Made

## Next Steps

## Important Context
