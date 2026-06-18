---
name: springboot-microservice-explore
description: Use when exploring a Spring Boot Java REST API microservices repository to build a repo map and risk map.
compatibility: opencode
---

# Spring Boot Microservice Explore

Read-only exploration skill for Spring Boot microservice repositories.

## Exploration Checklist

Identify and document the following:

- **Services/Modules** — List all Maven/Gradle modules
- **Build setup** — Maven (`pom.xml`) or Gradle (`build.gradle`/`build.gradle.kts`); root vs module configs
- **Controllers** — REST endpoints per service
- **Services** — Business logic layer
- **Repositories** — Spring Data JPA or other data access
- **DTOs** — Data transfer objects and mapping
- **Entities** — JPA entities, table mappings
- **Configs** — `application.yml`, `@Configuration`, `@Enable*` annotations
- **Tests** — Test structure, frameworks (JUnit, Mockito, Testcontainers)
- **API Gateway** — Spring Cloud Gateway or Zuul config
- **Discovery/Config** — Eureka, Consul, Spring Cloud Config
- **Docker/Compose** — `Dockerfile`, `docker-compose.yml`
- **Database Migrations** — Flyway, Liquibase, SQL scripts
- **Shared Modules** — Common libs, API DTO modules
- **Test/Build Commands** — `./mvnw test`, `./gradlew test`, etc.

## Output

Produce:
1. **Repo map** — File tree annotated with purpose per module
2. **Risk map** — Areas of concern (complexity, tight coupling, missing tests, etc.)

## Constraints

- Do **not** modify any files.
- Do **not** run destructive commands.
