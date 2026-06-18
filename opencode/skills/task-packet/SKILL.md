---
name: task-packet
description: Use when converting an approved big plan into bounded sub-plans or execution packets.
compatibility: opencode
---

# Task Packet

Break an approved architecture plan into bounded sub-plans (task packets). Each packet is a self-contained work unit.

## Task Packet Template

Every task packet must include:

| Field | Description |
|-------|-------------|
| **Agent** | Which agent role should execute this |
| **Required skills** | Skills the agent must load |
| **Task ID** | Unique identifier (e.g., `TASK-001`) |
| **Task name** | Short descriptive name |
| **Area/Module/Service** | Target area |
| **Goal** | What this task achieves |
| **Context** | Relevant background from the approved plan |
| **Allowed paths** | Files/directories the agent may touch |
| **Forbidden paths** | Files/directories the agent must never touch |
| **Dependencies** | Task IDs that must complete first |
| **Requirements** | Specific implementation requirements |
| **Acceptance criteria** | Verifiable conditions for completion |
| **Commands to run** | Build/test/lint commands |
| **Expected report** | What the agent must report back |
| **Parallel-safe** | Yes/No |
| **Risks** | Known risks or edge cases |

## Rules

- **Shared files and root configs** are **sequential by default** — do not mark as parallel-safe unless demonstrably isolated.
- **Builder tasks must never be vague** — every builder packet must have explicit allowed and forbidden paths.
- **Parallel execution** is allowed only when allowed paths do not overlap.
- If two packets modify the same file, they are sequential.
