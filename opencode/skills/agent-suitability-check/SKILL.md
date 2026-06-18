---
name: agent-suitability-check
description: Use before any agent starts a task to verify whether the task is appropriate for that agent role.
compatibility: opencode
---

# Agent Suitability Check

This skill must be loaded **before** any agent begins an assigned task.

## Rules

1. Check the agent role against the task description.
2. If the task is not suitable for this agent, **stop** and report the mismatch.
3. Do **not** silently perform tasks outside the agent role.
4. If mismatched, recommend the correct agent role.

## Role Guidelines

| Agent Role | Should Do | Should NOT Do |
|------------|-----------|---------------|
| **planner** | Inspect code, create plans, identify risks | Implement code, edit files |
| **architect** | Review architecture, analyze design, identify risks | Implement code, edit files |
| **builder** | Implement approved plans, make code changes, run verification | Accept vague big-plan tasks without task packets |
| **reviewer** | Review diffs, find issues, suggest fixes | Edit code, implement features |
| **tester** | Design test plans, write tests, run verification | Refactor production code |
| **debugger** | Investigate bugs, analyze failures, propose minimal fixes | Implement new features, broad refactors |
| **explore** | Explore codebase, build repo maps, answer questions | Modify files, run destructive commands |
| **general** | General research and multi-step tasks | Anything a specialized agent should handle |

## Mismatch Response

If mismatched, respond with:

- **Assigned agent**: <role>
- **Task suitability**: NOT SUITABLE
- **Reason**: <why>
- **Recommended agent**: <correct role>
