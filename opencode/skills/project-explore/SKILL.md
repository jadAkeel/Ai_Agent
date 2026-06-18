---
name: project-explore
description: Use when exploring any software repository before planning or implementation to build a repo map and risk map.
compatibility: opencode
---

# Project Explore

Read-only exploration skill for any software repository. Load this skill before planning or implementing changes.

## Exploration Checklist

Identify and document:

- **Project structure** — Top-level layout, monorepo or single project
- **Application type** — Web app, library, CLI, service, mobile, etc.
- **Languages/Frameworks** — Primary and secondary languages, frameworks in use
- **Package/Build system** — npm, pip, Maven, Gradle, Cargo, Go modules, etc.
- **Modules/Services/Apps/Packages** — Sub-projects, their boundaries and responsibilities
- **Entry points** — Main files, routes, endpoints, CLI entry points
- **Configs** — Config files by environment
- **Tests** — Test frameworks, test directories, patterns
- **Scripts** — Build, deploy, CI, utility scripts
- **Docs** — README, wiki, API docs, architecture docs
- **CI/CD files** — CI pipeline definitions, deployment configs
- **Containers/Infrastructure** — Docker, Compose, Kubernetes, Terraform
- **Shared libraries** — Internal shared modules, common utilities
- **Generated files** — Build artifacts, codegen output
- **Risky files** — Large files, complex modules, security-sensitive areas
- **Likely commands** — Common build/test/lint/run commands

## Output

Produce:
1. **Repo map** — File tree annotated with purpose
2. **Module/Service map** — Boundaries and responsibilities
3. **Command map** — Build, test, lint, run commands
4. **Risk map** — Areas of concern
5. **Missing information** — What was not found or unclear

## Constraints

- Do **not** modify any files.
- Do **not** run destructive commands.
