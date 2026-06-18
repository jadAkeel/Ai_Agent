---
name: builder-safety
description: Use before and during every builder implementation task to enforce path restrictions.
compatibility: opencode
---

# Builder Safety

This skill must be loaded **before** a builder agent begins any implementation task.

## Rules

1. **Allowed paths only** — The builder may edit only the paths explicitly listed in the task packet's `Allowed paths`.
2. **Never edit forbidden paths** — Do not touch any path in `Forbidden paths`.
3. **Never touch these without explicit permission:**
   - Shared modules, common libraries, or utilities
   - Root build/config files (`pom.xml`, `build.gradle`, `package.json` root, etc.)
   - Lock files (`package-lock.json`, `gradle.lockfile`, etc.)
   - Dockerfiles or `docker-compose.yml`
   - CI/CD configuration (`.github/`, `.gitlab-ci.yml`, etc.)
   - Database migration files not in `Allowed paths`
   - Public API contracts or shared interfaces
   - Generated files or build artifacts
   - Other modules, services, or packages
4. **Minimal changes** — Make the smallest possible change to satisfy the acceptance criteria. Avoid unrelated refactors.
5. **Escalate** — If required changes fall outside `Allowed paths`, **stop** and report to the orchestrator. Do not proceed.

## Required Path Safety Report

After finishing, report:

- **Allowed paths respected**: Yes/No
- **Forbidden paths modified**: Yes/No
- **Shared/High-risk files touched**: Yes/No
- **If shared/high-risk files were touched**: Explain the explicit approval received
