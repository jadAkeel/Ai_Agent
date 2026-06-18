---
name: project-testing
description: Use when validating any project or module by running tests, builds, and checks.
compatibility: opencode
---

# Project Testing

Validate any project or module by identifying and running relevant verification commands.

## When to Use

- After applying a fix to verify it works
- To reproduce a reported failure
- To validate build/test/lint/typecheck
- During debugging to confirm hypotheses

## Test Commands (run when safe)

Identify the project's build system and run appropriate commands:

- **npm/yarn/pnpm/bun**: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
- **Maven**: `./mvnw test`, `mvn test`, `mvn verify`
- **Gradle**: `./gradlew test`, `gradle test`, `gradle build`
- **Cargo**: `cargo test`, `cargo check`, `cargo clippy`
- **Go**: `go test ./...`, `go vet ./...`
- **Python**: `pytest`, `python -m pytest`, `ruff check`
- **Module-specific**: `./mvnw test -pl <module>`, `./gradlew :<module>:test`
- **Integration/E2E**: When configured, integration test commands
- **Build/Package**: `npm run build`, `./mvnw package`, `./gradlew build`

## Rules

- Prefer commands found in package files, build files, or project docs.
- Report exact commands and their results.
- Do **not** claim tests passed unless actually run and verified.
- If tests cannot run, explain why and provide exact commands for the user or orchestrator.
- Assess safety before running — skip destructive or long-running commands unless explicitly asked.
