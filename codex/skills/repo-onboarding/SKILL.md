---
name: repo-onboarding
description: Analyze any repository like a senior engineer joining the project. Use when the user asks to analyze this repo, understand this project, onboard to this codebase, create a project map, identify stack, architecture, commands, tests, risks, or conventions before editing.
---

# Repo Onboarding

Analyze the repository before implementation work. Treat this as read-only unless the user explicitly asks for edits.

## Workflow

1. Inspect real files before making claims: README files, package manifests, lockfiles, framework configs, source roots, route definitions, tests, scripts, CI config, Docker files, Makefiles, and documentation.
2. Identify the language, framework, runtime, package manager, architecture, entry points, and important modules.
3. Discover commands from actual files, not guesses.
4. Note conventions Codex should follow before editing.
5. Separate confirmed facts from unknowns or hypotheses.

## Output

Include:
- Project summary
- Stack and tools
- Directory map
- Main entry points
- Key modules
- Commands discovered
- Testing strategy
- Risks and unknowns
- Recommended next steps
