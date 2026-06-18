# Safe Publish Manifest

This repository stores the important, non-secret parts of the Codex -> MCP Bridge
-> OpenCode multi-agent system.

## Included

- MCP bridge source and package metadata.
- Main README and complete bridge guide.
- Global multi-agent architecture goal documents.
- Current Codex orchestrator and subagent configs.
- Current OpenCode agent configs.
- Current custom Codex skills, excluding bundled/system skills.
- Current OpenCode skills, excluding `.bak` files and `node_modules`.
- Sanitized Codex MCP config example.
- Sanitized OpenCode config and package metadata.

## Intentionally Excluded

- `~/.codex/auth.json`
- Codex session, state, history, logs, sqlite, cache, sandbox, and attachment files.
- Raw `~/.codex/config.toml`, because it contains machine/runtime paths.
- Raw `~/.codex/rules/default.rules`, because it contains machine-local shell
  approvals and project-specific commands.
- `.env` and `.env.*`
- `node_modules`
- Generated worktrees, lock databases, runtime logs, and backup files.

## Restore Notes

Copy files back intentionally. Do not blindly overwrite local config directories.

- Codex agents: `codex/agents/` -> `~/.codex/agents/`
- Codex skills: `codex/skills/` -> `~/.codex/skills/`
- OpenCode agents: `opencode/agents/` -> `~/.config/opencode/agents/`
- OpenCode skills: `opencode/skills/` -> `~/.config/opencode/skills/`
- OpenCode config: fill provider placeholders in `opencode/opencode.jsonc`
  before copying it to
  `~/.config/opencode/opencode.jsonc`
- Codex MCP config: adapt `codex/config.example.toml` instead of copying raw
  machine config.
