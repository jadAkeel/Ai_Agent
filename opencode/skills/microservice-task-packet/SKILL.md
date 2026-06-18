---
name: microservice-task-packet
description: Use when converting an approved architecture plan into service-level sub-plans with task packets.
compatibility: opencode
---

# Microservice Task Packet

Break an approved architecture plan into service-level sub-plans. Each sub-plan is a **task packet**.

## Task Packet Template

Each packet must contain:

| Field | Description |
|-------|-------------|
| **Agent** | Which agent type (builder, tester, etc.) |
| **Task ID** | Unique identifier (e.g., `TASK-001`) |
| **Task name** | Short descriptive name |
| **Service/Module** | Target service or module |
| **Goal** | What this task achieves |
| **Context** | Relevant background from the approved plan |
| **Allowed paths** | Files/directories the builder may touch |
| **Forbidden paths** | Files/directories the builder must never touch |
| **Dependencies** | Task IDs that must complete first |
| **Requirements** | Specific implementation requirements |
| **Acceptance criteria** | Verifiable conditions for completion |
| **Commands to run** | Build/test/lint commands |
| **Expected report** | What the agent must report back |
| **Parallel-safe** | Yes/No |
| **Risks** | Known risks or edge cases |

## Sequencing Rules

- Tasks touching **shared files** or **root configs** must be **sequential** unless they are demonstrably isolated.
- Tasks on distinct services with no shared dependencies may be marked **parallel-safe**.
- If two tasks modify the same file, they are **sequential**.
