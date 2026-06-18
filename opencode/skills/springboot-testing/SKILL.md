---
name: springboot-testing
description: Use when validating Spring Boot Java services by running tests and reporting results.
compatibility: opencode
---

# Spring Boot Testing

Validate Spring Boot Java services by running tests safely.

## Test Commands (run when safe)

Detect and run the appropriate commands:

- `./mvnw test` (Maven Wrapper)
- `mvn test` (Maven)
- `./gradlew test` (Gradle Wrapper)
- `gradle test` (Gradle)
- Module-specific tests: `./mvnw test -pl <module>` or `./gradlew :<module>:test`
- Spring context load tests if detected
- Integration tests if configured (e.g., `mvn verify`, `mvn integration-test`)
- Package/build command when relevant (`./mvnw package`, `./gradlew build`)

## Reporting

After execution, report:

- **Commands run** — What was actually executed
- **Results** — Pass/fail summary
- **Failures** — Specific test failures with details
- **User commands** — If tests cannot be run (e.g., missing tooling), provide the exact command the user should run manually

## Rules

- Do **not** claim tests passed unless they were actually executed and verified.
- Do **not** modify test files or production code.
- Assess safety before running — skip destructive or long-running tests if uncertain.
