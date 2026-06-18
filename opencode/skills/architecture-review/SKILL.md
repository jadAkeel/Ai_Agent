---
name: architecture-review
description: Use before implementation on architecture-sensitive, multi-module, multi-service, or high-risk changes.
compatibility: opencode
---

# Architecture Review

Review architecture plans before any implementation begins. Use for multi-module, multi-service, or high-risk changes.

## Review Checklist

- **Module/Service boundaries** — Are responsibilities correctly split? Is there overlap or tight coupling?
- **API/Interface contracts** — Are endpoints, methods, request/response shapes well-defined and stable?
- **Data ownership** — Does each module/service own its data? No unintended sharing?
- **Shared dependency risks** — What shared libraries or configs create coupling or fragility?
- **Transaction/Consistency risks** — Where are distributed transactions or eventual consistency needed?
- **Auth/Security flow** — How does authentication and authorization propagate across boundaries?
- **Integration points** — Are integration touchpoints clear and versioned?
- **Migration risks** — Are schema or data migrations backward-compatible?
- **Backward compatibility** — Will existing consumers break?
- **Parallel execution risk** — Can tasks run in parallel safely?
- **Scalability/Maintainability** — Will the design scale and remain maintainable?

## Output

1. **Findings by severity**: Critical, High, Medium, Low
2. **Corrected execution order** — Recommended order to implement
3. **Shared-risk warnings** — Components that create coupling risk
4. **Approval/Blocker recommendation** — Is the architecture ready for implementation?

## Constraints

- Do **not** implement any code.
- Do **not** modify any files.
