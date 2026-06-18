---
name: builder-path-safety
description: Use before any builder implementation task to enforce path restrictions.
compatibility: opencode
---

# Builder Path Safety

This skill must be loaded **before** a builder agent begins any implementation task.

## Rules

1. **Allowed paths only** — The builder may edit only the paths explicitly listed in the task packet's `Allowed paths`.
2. **Never edit forbidden paths** — Do not touch any path in `Forbidden paths`.
3. **Never touch these without explicit permission:**
   - Shared modules / common libraries
   - Root `pom.xml`, `build.gradle`, or `build.gradle.kts`
   - Lock files (`pom.xml.lockfile`, `gradle.lockfile`, `package-lock.json`)
   - Dockerfiles or `docker-compose.yml`
   - CI/CD configuration (`.github/`, `.gitlab-ci.yml`, etc.)
   - Database migration files not in `Allowed paths`
   - API gateway configuration
   - Other service modules
4. **Minimal changes** — Make the smallest change possible to satisfy the acceptance criteria.
5. **Escalate** — If required changes fall outside `Allowed paths`, **stop** and report to the orchestrator. Do not proceed.

## Post-Task Report

After completing the task, report:

- Files changed
- Path safety confirmed (Yes/No)
- Any violations or escalations
