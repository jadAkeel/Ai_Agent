---
name: implementation-planner
description: Plan changes before editing code. Use when the user asks to plan this change, create a plan before editing, analyze the task first, how should we implement this, or wants a step-by-step implementation plan with risks and verification.
---

# Implementation Planner

Plan significant changes before editing. Do not modify files unless the user explicitly says to proceed.

## Workflow

1. Restate the goal and current understanding.
2. Inspect relevant files or identify which files must be inspected.
3. List assumptions, unknowns, risks, edge cases, and public API or data contract concerns.
4. Propose the smallest practical approach that fits existing architecture and style.
5. Define a verification plan before coding.
6. End with the clear next action.

## Output

Include:
- Goal
- Current understanding
- Files to inspect
- Proposed approach
- Risks
- Test plan
- Questions or assumptions
- Clear next action
