#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const OPENCODE_EXE = "C:\\Users\\10User\\.opencode\\bin\\opencode.exe";
const OPENCODE_AGENT_DIR = "C:\\Users\\10User\\.config\\opencode\\agents";
const DEFAULT_SUBAGENT_PROXY_AGENT = "build";
const WRITE_CAPABLE_AGENTS = new Set(["build", "builder", "debugger", "general"]);
const READ_ONLY_PARALLEL_AGENTS = new Set(["planner", "reviewer", "architect", "explore", "explorer", "tester"]);
const PARALLEL_LOCK_TYPES = new Set(["read", "write", "serial_integration"]);
const GLOBAL_BRIDGE_STATE_DIR = "C:\\Users\\10User\\.codex\\codex-opencode-mcp";
const DEFAULT_LOCK_TTL_MS = 1000 * 60 * 30;
const ALLOW_ORCHESTRATOR_WRITE_THROUGH_MCP = false;
const CONFIG = Object.freeze({
  readOnlyAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS", 1000 * 60 * 3),
  writeAgentTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS", 1000 * 60 * 10),
  builderTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_BUILDER_TIMEOUT_MS", 1000 * 60 * 15),
  orchestratorTimeoutMs: readPositiveIntEnv("CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS", 1000 * 60 * 20),
  maxReadOnlyAgentRetries: readPositiveIntEnv("CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES", 2),
  defaultReadLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE", ["off"], "off"),
  defaultWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE", ["simple", "strict"], "simple"),
  defaultParallelWriteLockMode: readChoiceEnv("CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE", ["strict"], "strict"),
  parallelLimit: readPositiveIntEnv("CODEX_OPENCODE_PARALLEL_LIMIT", 6),
  logLevel: readChoiceEnv("CODEX_OPENCODE_LOG_LEVEL", ["off", "error", "warn", "info", "debug"], "warn"),
  worktreeMode: readChoiceEnv("CODEX_OPENCODE_WORKTREE_MODE", ["off", "write", "all"], "off"),
  worktreeRoot: String(process.env.CODEX_OPENCODE_WORKTREE_ROOT || ".codex-worktrees").trim() || ".codex-worktrees",
  worktreeCleanup: readChoiceEnv("CODEX_OPENCODE_WORKTREE_CLEANUP", ["always", "on_success", "never"], "never"),
  worktreeBranchPrefix: String(process.env.CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX || "agent").trim() || "agent",
  queueMode: readChoiceEnv("CODEX_OPENCODE_QUEUE_MODE", ["off", "memory", "sqlite"], "memory"),
  queueParallelLimit: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT", 6),
  queueWriteConflictPolicy: readChoiceEnv("CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY", ["reject", "wait"], "wait"),
  queueReadOnlyRetries: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_READONLY_RETRIES", 2),
  queueWriteRetries: readPositiveIntEnv("CODEX_OPENCODE_QUEUE_WRITE_RETRIES", 0),
});
const SERIAL_ONLY_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.*.json",
  "vite.config.*",
  "next.config.*",
  "nuxt.config.*",
  "webpack.config.*",
  "rollup.config.*",
  "eslint.config.*",
  ".eslintrc*",
  ".prettierrc*",
  ".env",
  ".env.*",
  "README.md",
  "CHANGELOG.md",
  "src/index.*",
  "src/main.*",
  "src/app.*",
  "src/routes/**",
  "app/routes/**",
  "db/migrations/**",
  "prisma/schema.prisma",
]);
const defaultReadOnlyAgentTimeoutMs = CONFIG.readOnlyAgentTimeoutMs;
const defaultWriteAgentTimeoutMs = CONFIG.writeAgentTimeoutMs;
const defaultBuilderTimeoutMs = CONFIG.builderTimeoutMs;
const defaultOrchestratorTimeoutMs = CONFIG.orchestratorTimeoutMs;
const maxReadOnlyAgentRetries = CONFIG.maxReadOnlyAgentRetries;
const LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, info: 3, debug: 4 });
const DEFAULT_RETURN_FORMAT = [
  "1. Summary",
  "2. Lock used",
  "3. Files inspected",
  "4. Files changed",
  "5. Files wanted but not edited",
  "6. Changes made or proposed",
  "7. NEEDS_INTEGRATION, if required",
  "8. Risks",
  "9. Validation performed",
  "10. Validation still recommended",
].join("\n");
const QUEUE_JOBS = new Map();
let queueSchedulerActive = false;

const server = new McpServer({
  name: "codex-opencode-bridge",
  version: "0.1.0",
});

const scopePathSetSchema = z
  .object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
  })
  .strict();

const scopeValidationSchema = z
  .object({
    changedFilesMustBeWithinWriteScope: z.boolean().optional(),
    forbiddenFilesMustNotChange: z.boolean().optional(),
    readOnlyMustNotChangeFiles: z.boolean().optional(),
  })
  .strict();

const scopeTimeoutPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    readOnlyTimeoutMs: z.number().int().positive().optional(),
    writeTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const scopeContractSchema = z
  .object({
    agent: z.string().optional(),
    role: z.string().optional(),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
    scope: scopePathSetSchema.optional(),
    actions: z.array(z.string()).optional(),
    validation: scopeValidationSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    timeoutPolicy: scopeTimeoutPolicySchema.optional(),
  })
  .strict();

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readChoiceEnv(name, allowedValues, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return allowedValues.includes(value) ? value : fallback;
}

function sanitizeLogValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  }

  if (Array.isArray(value)) {
    if (depth > 2) {
      return `[${value.length} items]`;
    }
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    if (depth > 2) {
      return "[object]";
    }

    const safe = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (/prompt|stdout|stderr|env|token|secret|password|api[-_]?key/i.test(key)) {
        continue;
      }
      safe[key] = sanitizeLogValue(childValue, depth + 1);
    }
    return safe;
  }

  return String(value);
}

function logEvent(level, event, data = {}) {
  const configuredLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.warn;
  const eventLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (configuredLevel < eventLevel) {
    return;
  }

  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogValue(data),
  }));
}

async function runCommand(command, args, cwd, timeoutMs = 1000 * 90, env = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: cwd || process.cwd(),
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 30,
      env: { ...process.env, ...env },
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || String(error),
      exitCode: error.code || (error.killed ? "timeout" : 1),
    };
  }
}

async function runSpawnCommand(command, args, cwd, timeoutMs = 1000 * 90, env = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdin.end();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: [stderr, String(error)].filter(Boolean).join("\n"),
        exitCode: error.code || 1,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : code ?? signal ?? 1,
        timedOut,
      });
    });
  });
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function summarizeStderr(stderr) {
  return (stderr || "").trim().split(/\r?\n/).slice(0, 12).join("\n");
}

function sanitizeAgentName(agent) {
  const normalized = String(agent || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid agent name "${agent}". Use only letters, numbers, dashes, or underscores.`);
  }
  return normalized;
}

function parseAgentList(output) {
  const agents = new Map();
  for (const line of (output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s+\((primary|subagent|all)\)/);
    if (match) {
      agents.set(match[1], match[2]);
    }
  }
  return agents;
}

async function listAvailableAgents(cwd) {
  const result = await runCommand(OPENCODE_EXE, ["agent", "list"], cwd, 1000 * 30);
  return {
    result,
    agents: parseAgentList(result.stdout || result.stderr),
  };
}

async function debugAgentExists(agent, cwd) {
  const result = await runCommand(OPENCODE_EXE, ["debug", "agent", agent], cwd, 1000 * 20);
  if (result.exitCode !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.name === agent ? parsed?.mode || "unknown" : null;
  } catch {
    return null;
  }
}

function availableAgentLabels(agents) {
  return [...agents.entries()].map(([name, mode]) => `${name} (${mode})`).sort();
}

function detectsOpenCodeFallback(stderr) {
  return /agent\s+"[^"]+"\s+is a subagent,\s+not a primary agent\.\s+Falling back to default agent/i.test(stderr || "");
}

function detectsOpenCodeApiError(stdout) {
  for (const line of (stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "error" || event?.error || event?.data?.error) {
        return true;
      }
    } catch {
      if (/\b(APIError|CreditsError|No payment method)\b/i.test(trimmed)) {
        return true;
      }
    }
  }

  return false;
}

async function readAgentDefinition(agent) {
  try {
    return await readFile(`${OPENCODE_AGENT_DIR}\\${agent}.md`, "utf8");
  } catch {
    return "";
  }
}

function buildSubagentProxyPrompt(requestedAgent, agentDefinition, taskPrompt) {
  return [
    `You are acting as the OpenCode subagent "${requestedAgent}" for a Codex MCP delegation.`,
    "",
    "OpenCode CLI cannot run this subagent as a top-level primary agent in this environment, so the bridge is proxying the role through a primary OpenCode agent.",
    "Follow the subagent definition below as the controlling role instructions for this task.",
    "",
    "===== SUBAGENT DEFINITION BEGIN =====",
    agentDefinition || `No local definition file was found for ${requestedAgent}. Follow the requested role name and task packet strictly.`,
    "===== SUBAGENT DEFINITION END =====",
    "",
    "===== CODEX TASK BEGIN =====",
    taskPrompt,
    "===== CODEX TASK END =====",
  ].join("\n");
}

async function resolveAgent(requestedAgent, cwd, allowFallbackToBuild = false, subagentStrategy = "proxy", proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT) {
  const agent = sanitizeAgentName(requestedAgent);
  const normalizedStrategy = String(subagentStrategy || "proxy").trim().toLowerCase();
  const normalizedProxyAgent = sanitizeAgentName(proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT);
  const { result, agents } = await listAvailableAgents(cwd);
  let mode = agents.get(agent);

  if (!mode) {
    mode = await debugAgentExists(agent, cwd);
  }

  if (mode && mode !== "subagent") {
    return {
      requestedAgent: agent,
      requestedAgentMode: mode,
      actualAgent: agent,
      fallbackUsed: false,
      proxyUsed: false,
      subagentStrategy: "direct",
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (mode === "subagent") {
    if (normalizedStrategy === "reject") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" is a subagent. This OpenCode CLI version does not run subagents as top-level agents through "opencode run --agent ${agent}". Use subagentStrategy "proxy" to run it through "${DEFAULT_SUBAGENT_PROXY_AGENT}", or "direct" only if you want to test native CLI behavior.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    if (normalizedStrategy === "direct") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: agent,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: null,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    let proxyMode = agents.get(normalizedProxyAgent);
    if (!proxyMode) {
      proxyMode = await debugAgentExists(normalizedProxyAgent, cwd);
    }

    if (!proxyMode || proxyMode === "subagent") {
      return {
        requestedAgent: agent,
        requestedAgentMode: mode,
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" is a subagent, but proxy agent "${normalizedProxyAgent}" is not an available primary/all agent.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    return {
      requestedAgent: agent,
      requestedAgentMode: mode,
      actualAgent: normalizedProxyAgent,
      actualAgentMode: proxyMode,
      fallbackUsed: false,
      proxyUsed: true,
      subagentStrategy: normalizedStrategy || "proxy",
      proxyReason: `OpenCode CLI reports "${agent}" as a subagent, so the bridge is proxying it through "${normalizedProxyAgent}".`,
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  if (allowFallbackToBuild) {
    let buildMode = agents.get("build");
    if (!buildMode) {
      buildMode = await debugAgentExists("build", cwd);
    }

    if (!buildMode || buildMode === "subagent") {
      return {
        requestedAgent: agent,
        requestedAgentMode: "missing",
        actualAgent: null,
        fallbackUsed: false,
        proxyUsed: false,
        subagentStrategy: normalizedStrategy,
        error: `OpenCode agent "${agent}" was not found, and fallback agent "build" was also not found.`,
        availableAgents: availableAgentLabels(agents),
        discoveryExitCode: result.exitCode,
      };
    }

    return {
      requestedAgent: agent,
      requestedAgentMode: "missing",
      actualAgent: "build",
      actualAgentMode: buildMode,
      fallbackUsed: true,
      fallbackReason: `Requested agent "${agent}" was not found and fallback to "build" was explicitly allowed.`,
      proxyUsed: false,
      subagentStrategy: normalizedStrategy,
      error: null,
      availableAgents: availableAgentLabels(agents),
      discoveryExitCode: result.exitCode,
    };
  }

  return {
    requestedAgent: agent,
    requestedAgentMode: "missing",
    actualAgent: null,
    fallbackUsed: false,
    proxyUsed: false,
    subagentStrategy: normalizedStrategy,
    error: `OpenCode agent "${agent}" was not found. Fallback to build was not used because allowFallbackToBuild is false.`,
    availableAgents: availableAgentLabels(agents),
    discoveryExitCode: result.exitCode,
  };
}

function normalizeList(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.filter(Boolean) : [String(value)];
}

function uniqueList(values) {
  return [...new Set(normalizeList(values).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeLockPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  return raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "");
}

function unsafePathReason(paths, cwd = "") {
  const root = cwd ? path.resolve(cwd) : "";
  for (const rawPath of normalizeList(paths)) {
    const raw = String(rawPath || "");
    const normalized = normalizeLockPath(raw);
    const label = JSON.stringify(raw);

    if (!normalized) {
      return `Unsafe path ${label} is empty.`;
    }

    if (/[\0\r\n]/.test(raw)) {
      return `Unsafe path ${label} contains control characters.`;
    }

    if (normalized === "~" || normalized.startsWith("~/")) {
      return `Unsafe path ${label} uses a home-directory shortcut. Use an explicit path.`;
    }

    if (normalized === "." || normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
      return `Unsafe path ${label} targets a filesystem root. Use a bounded file or directory.`;
    }

    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      return `Unsafe path ${label} includes parent traversal.`;
    }

    if (isAbsolutePathLike(normalized) && root) {
      const resolved = path.resolve(normalized);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return `Unsafe path ${label} resolves outside the allowed root ${root}.`;
      }
    }
  }

  return "";
}

function normalizeLockPathList(values) {
  return [...new Set(uniqueList(values).map(normalizeLockPath).filter(Boolean))];
}

function mergePathLists(...values) {
  return normalizeLockPathList(values.flatMap((value) => normalizeList(value)));
}

function normalizeScopeMode(mode) {
  const raw = String(mode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return "";
  }
  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }
  if (raw === "write" || raw === "read") {
    return raw;
  }
  return raw;
}

function rawScopeContractInput(job) {
  if (job?.scopeContract) {
    return job.scopeContract;
  }

  if (job?.delegation?.scopeContract) {
    return job.delegation.scopeContract;
  }

  if (job?.scope && !Array.isArray(job.scope) && typeof job.scope === "object") {
    return {
      agent: job.agent,
      role: job.role,
      mode: job.mode,
      scope: job.scope,
      actions: job.actions,
      validation: job.validation,
      timeoutMs: job.timeoutMs,
      timeoutPolicy: job.timeoutPolicy,
    };
  }

  if (job?.delegation?.scope && !Array.isArray(job.delegation.scope) && typeof job.delegation.scope === "object") {
    return {
      agent: job.agent,
      role: job.delegation.role,
      mode: job.delegation.mode,
      scope: job.delegation.scope,
      actions: job.delegation.actions,
      validation: job.delegation.validation,
      timeoutMs: job.delegation.timeoutMs,
      timeoutPolicy: job.delegation.timeoutPolicy,
    };
  }

  return null;
}

function normalizeScopeContract(job) {
  const raw = rawScopeContractInput(job);
  if (!raw) {
    return null;
  }

  const normalized = {
    agent: String(raw.agent || job.agent || "").trim(),
    role: String(raw.role || "").trim(),
    mode: normalizeScopeMode(raw.mode),
    scope: {
      read: normalizeLockPathList(raw.scope?.read),
      write: normalizeLockPathList(raw.scope?.write),
      forbidden: normalizeLockPathList(raw.scope?.forbidden),
    },
    actions: uniqueList(raw.actions).map((action) => String(action).trim()).filter(Boolean),
    validation: {
      changedFilesMustBeWithinWriteScope: raw.validation?.changedFilesMustBeWithinWriteScope !== false,
      forbiddenFilesMustNotChange: raw.validation?.forbiddenFilesMustNotChange !== false,
      readOnlyMustNotChangeFiles: raw.validation?.readOnlyMustNotChangeFiles !== false,
    },
    timeoutMs: raw.timeoutMs || raw.timeoutPolicy?.timeoutMs || null,
    timeoutPolicy: {
      readOnlyTimeoutMs: raw.timeoutPolicy?.readOnlyTimeoutMs || null,
      writeTimeoutMs: raw.timeoutPolicy?.writeTimeoutMs || null,
    },
  };

  if (!normalized.mode) {
    normalized.mode = normalized.scope.write.length ? "write" : "read";
  }

  return normalized;
}

function scopeContractPathInputs(scopeContract) {
  return scopeContract
    ? scopeContract.scope.read.concat(scopeContract.scope.write, scopeContract.scope.forbidden)
    : [];
}

function scopeContractTimeout(scopeContract, lockType) {
  if (!scopeContract) {
    return null;
  }
  if (scopeContract.timeoutMs) {
    return scopeContract.timeoutMs;
  }
  return lockType === "read"
    ? scopeContract.timeoutPolicy.readOnlyTimeoutMs
    : scopeContract.timeoutPolicy.writeTimeoutMs;
}

function formatScopeContractForPrompt(scopeContract) {
  if (!scopeContract) {
    return "";
  }

  return [
    `Agent: ${scopeContract.agent || "not specified"}`,
    `Role: ${scopeContract.role || "not specified"}`,
    `Mode: ${scopeContract.mode}`,
    `Read paths: ${scopeContract.scope.read.length ? scopeContract.scope.read.join(", ") : "not specified"}`,
    `Write paths: ${scopeContract.scope.write.length ? scopeContract.scope.write.join(", ") : "none"}`,
    `Forbidden paths: ${scopeContract.scope.forbidden.length ? scopeContract.scope.forbidden.join(", ") : "none"}`,
    `Allowed actions: ${scopeContract.actions.length ? scopeContract.actions.join(", ") : "not specified"}`,
    `Validation changedFilesMustBeWithinWriteScope: ${scopeContract.validation.changedFilesMustBeWithinWriteScope ? "yes" : "no"}`,
    `Validation forbiddenFilesMustNotChange: ${scopeContract.validation.forbiddenFilesMustNotChange ? "yes" : "no"}`,
    `Validation readOnlyMustNotChangeFiles: ${scopeContract.validation.readOnlyMustNotChangeFiles ? "yes" : "no"}`,
  ].join("\n");
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern) {
  const normalized = normalizeLockPath(pattern);
  let regex = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char);
    }
  }
  return new RegExp(`^${regex}$`, "i");
}

function serialPatternStaticPrefix(pattern) {
  const normalized = normalizeLockPath(pattern);
  const wildcardIndex = normalized.search(/[*?[\]{}!]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return normalizeLockPath(prefix.replace(/\/[^/]*$/, ""));
}

function pathOverlapsSerialPattern(candidate, pattern) {
  const normalizedCandidate = normalizeLockPath(candidate);
  const normalizedPattern = normalizeLockPath(pattern);
  if (!normalizedCandidate || !normalizedPattern) {
    return false;
  }

  if (globToRegex(normalizedPattern).test(normalizedCandidate)) {
    return true;
  }

  const staticPrefix = serialPatternStaticPrefix(normalizedPattern);
  if (staticPrefix && overlaps([normalizedCandidate], [staticPrefix])) {
    return true;
  }

  if (!/[*?[\]{}!]/.test(normalizedPattern)) {
    return Boolean(overlaps([normalizedCandidate], [normalizedPattern]));
  }

  return false;
}

function findSerialOnlyMatches(paths) {
  const matches = [];
  const seen = new Set();
  for (const candidate of normalizeLockPathList(paths)) {
    for (const pattern of SERIAL_ONLY_PATHS) {
      if (pathOverlapsSerialPattern(candidate, pattern)) {
        const label = `${candidate} (${pattern})`;
        if (!seen.has(label)) {
          matches.push(label);
          seen.add(label);
        }
      }
    }
  }
  return matches;
}

function firstNonEmptyList(...values) {
  for (const value of values) {
    const list = normalizeLockPathList(value);
    if (list.length) {
      return list;
    }
  }
  return [];
}

function buildCompactPrompt(agent, task, delegation = {}) {
  if (!delegation || Object.keys(delegation).length === 0) {
    return task;
  }

  return [
    `Role: ${agent}`,
    "",
    `Task: ${task}`,
    "",
    "Scope:",
    Array.isArray(delegation.scope) ? normalizeList(delegation.scope).join("\n") || "Not specified." : "Not specified.",
    "",
    "Scope Contract:",
    formatScopeContractForPrompt(delegation.scopeContract) || "Not specified.",
    "",
    `Lock mode: ${delegation.lockMode || "not specified"}`,
    "",
    `Lock type: ${delegation.lockType || "not specified"}`,
    "",
    isOrchestratorAgent(agent) ? `OpenCode Orchestrator Large Task Mode: ${delegation.orchestratorMode || "planning-only"}` : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode === "bounded-writer"
      ? "Act as one bounded writer only. Do not run, spawn, invoke, or delegate to internal builders, debuggers, writers, or parallel subagents."
      : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode === "planning-only"
      ? "Planning-only mode. Do not write files. Return an implementation plan, affected paths, allowedEdits proposal, risks, tests, and follow-up builder/debugger jobs for Codex to run through MCP."
      : null,
    "",
    "Lock granted:",
    normalizeList(delegation.lockedPaths).join("\n") || "Not specified.",
    "",
    "Allowed edits:",
    normalizeList(delegation.allowedEdits).join("\n") || "none",
    "",
    "Forbidden edits:",
    normalizeList(delegation.forbiddenEdits).join("\n") || "none specified",
    "",
    `Shared files frozen: ${normalizeList(delegation.sharedFiles).join(", ") || "Not specified."}`,
    "",
    "Permissions:",
    delegation.permissions || "Not specified.",
    "",
    `Validation command: ${delegation.validationCommand || "Not specified."}`,
    "",
    "If you need files outside the lock:",
    "Do not edit them. Return NEEDS_INTEGRATION with the file/path needed, reason, and recommended change.",
    "",
    "Return format:",
    delegation.returnFormat || DEFAULT_RETURN_FORMAT,
  ].join("\n");
}

function commandShape(agent) {
  return `${OPENCODE_EXE} run --format json --title "Codex MCP bridge task" --agent ${agent} <prompt>`;
}

function timeoutForAgent(agent, lockPlan, requestedTimeoutMs = null) {
  const explicit = Number(requestedTimeoutMs);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const normalizedAgent = String(agent || "").toLowerCase();
  if (normalizedAgent === "builder") {
    return defaultBuilderTimeoutMs;
  }

  if (normalizedAgent === "orchestrator") {
    return defaultOrchestratorTimeoutMs;
  }

  return lockPlan?.lockType === "read" ? defaultReadOnlyAgentTimeoutMs : defaultWriteAgentTimeoutMs;
}

function isTimeoutResult(result) {
  return result?.timedOut || result?.exitCode === 124 || result?.exitCode === "timeout";
}

function classifyResultError(result) {
  if (!result) {
    return null;
  }

  if (isTimeoutResult(result)) {
    return "agent_timeout";
  }

  if (result.openCodeFallbackDetected) {
    return "opencode_native_fallback";
  }

  if (result.openCodeApiErrorDetected) {
    return "opencode_api_error";
  }

  if (result.exitCode !== 0) {
    return "agent_exit_nonzero";
  }

  return null;
}

async function runOpenCode(agent, prompt, cwd, dryRun = false, timeoutMs = defaultWriteAgentTimeoutMs) {
  const workDir = cwd || process.cwd();
  const started = nowMs();

  if (dryRun) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      commandShape: commandShape(agent),
      dryRun: true,
      timeoutMs,
      timedOut: false,
      errorType: null,
      openCodeFallbackDetected: false,
      openCodeApiErrorDetected: false,
    };
  }

  const result = await runSpawnCommand(
    OPENCODE_EXE,
    ["run", "--format", "json", "--title", "Codex MCP bridge task", "--agent", agent, prompt],
    workDir,
    timeoutMs
  );

  const openCodeFallbackDetected = detectsOpenCodeFallback(result.stderr);
  const openCodeApiErrorDetected = detectsOpenCodeApiError(result.stdout);
  const runResult = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: nowMs() - started,
    commandShape: commandShape(agent),
    dryRun: false,
    timeoutMs,
    timedOut: isTimeoutResult(result),
    openCodeFallbackDetected,
    openCodeApiErrorDetected,
  };
  runResult.errorType = classifyResultError(runResult);
  return runResult;
}

async function runOpenCodeWithPolicy(agent, prompt, cwd, dryRun, lockPlan, requestedTimeoutMs = null) {
  const timeoutMs = timeoutForAgent(agent, lockPlan, requestedTimeoutMs);

  if (lockPlan?.lockType !== "read") {
    const result = await runOpenCode(agent, prompt, cwd, dryRun, timeoutMs);
    result.retryAttempt = 0;
    result.maxRetries = 0;
    logOpenCodeResult(agent, result, lockPlan);
    return result;
  }

  let lastResult = null;
  for (let attempt = 0; attempt <= maxReadOnlyAgentRetries; attempt += 1) {
    lastResult = await runOpenCode(agent, prompt, cwd, dryRun, timeoutMs);
    lastResult.retryAttempt = attempt;
    lastResult.maxRetries = maxReadOnlyAgentRetries;
    logOpenCodeResult(agent, lastResult, lockPlan);
    if (!isTimeoutResult(lastResult)) {
      return lastResult;
    }
  }

  return {
    ...lastResult,
    readOnlyUnavailable: true,
    errorType: "read_only_agent_unavailable",
    stderr: [
      lastResult?.stderr || "",
      `Read-only agent timed out after ${maxReadOnlyAgentRetries + 1} attempts and was marked unavailable.`,
    ].filter(Boolean).join("\n"),
  };
}

function logOpenCodeResult(agent, result, lockPlan = null) {
  const level = result?.errorType ? "warn" : "info";
  logEvent(level, "opencode.agent_result", {
    agent,
    command: result?.commandShape,
    durationMs: result?.durationMs ?? 0,
    lockMode: lockPlan?.lockMode || "unknown",
    lockType: lockPlan?.lockType || "unknown",
    retries: result?.retryAttempt ?? 0,
    maxRetries: result?.maxRetries ?? 0,
    exitCode: result?.exitCode ?? "not run",
    timedOut: Boolean(result?.timedOut),
    dryRun: Boolean(result?.dryRun),
  });
}

function formatSingleResult({ resolution, result, cwd, lockPlan = null }) {
  return [
    `Requested agent: ${resolution.requestedAgent}`,
    `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
    `Actual agent used: ${resolution.actualAgent || "none"}`,
    `Actual agent mode: ${resolution.actualAgentMode || resolution.requestedAgentMode || "unknown"}`,
    `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
    resolution.fallbackReason ? `Fallback reason: ${resolution.fallbackReason}` : null,
    `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
    `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
    `OpenCode native fallback detected: ${result?.openCodeFallbackDetected ? "yes" : "no"}`,
    `OpenCode API error detected: ${result?.openCodeApiErrorDetected ? "yes" : "no"}`,
    resolution.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Working directory: ${cwd || process.cwd()}`,
    result?.worktree ? `Worktree path: ${result.worktree.path}` : null,
    result?.worktree ? `Worktree branch: ${result.worktree.branch}` : null,
    result?.worktree ? `Worktree cleanup: ${result.worktree.cleanup}` : null,
    `Command shape: ${result?.commandShape || "not run"}`,
    `Dry run: ${result?.dryRun ? "yes" : "no"}`,
    `Error type: ${result?.errorType || "none"}`,
    result?.timedOut ? `Agent timeout: ${resolution.actualAgent || resolution.requestedAgent}` : null,
    `Timeout ms: ${result?.timeoutMs ?? "not specified"}`,
    `Timed out: ${result?.timedOut ? "yes" : "no"}`,
    `Read-only unavailable: ${result?.readOnlyUnavailable ? "yes" : "no"}`,
    `Retry attempts used: ${result?.retryAttempt ?? 0}`,
    `Max retries: ${result?.maxRetries ?? 0}`,
    `Lock mode: ${lockPlan?.lockMode || "not specified"}`,
    `Lock type: ${lockPlan?.lockType || "not specified"}`,
    lockPlan?.orchestratorMode ? `Orchestrator mode: ${lockPlan.orchestratorMode}` : null,
    `Lock granted: ${lockPlan?.lockedPaths?.length ? lockPlan.lockedPaths.join(", ") : "not specified"}`,
    `Allowed edits: ${lockPlan?.allowedEdits?.length ? lockPlan.allowedEdits.join(", ") : "none"}`,
    `Forbidden edits: ${lockPlan?.forbiddenEdits?.length ? lockPlan.forbiddenEdits.join(", ") : "none specified"}`,
    lockPlan?.scopeContract ? `Scope Contract role: ${lockPlan.scopeContract.role || "not specified"}` : null,
    lockPlan?.scopeContract ? `Scope Contract mode: ${lockPlan.scopeContract.mode}` : null,
    lockPlan?.scopeContract ? `Scope read paths: ${lockPlan.scopeContract.scope.read.length ? lockPlan.scopeContract.scope.read.join(", ") : "not specified"}` : null,
    lockPlan?.scopeContract ? `Scope write paths: ${lockPlan.scopeContract.scope.write.length ? lockPlan.scopeContract.scope.write.join(", ") : "none"}` : null,
    lockPlan?.scopeContract ? `Scope forbidden paths: ${lockPlan.scopeContract.scope.forbidden.length ? lockPlan.scopeContract.scope.forbidden.join(", ") : "none"}` : null,
    `Shared files frozen: ${lockPlan?.sharedFiles?.length ? lockPlan.sharedFiles.join(", ") : "none specified"}`,
    `Files changed: ${result?.changedFiles?.length ? result.changedFiles.join(", ") : "none detected"}`,
    `Exit code: ${result?.exitCode ?? "not run"}`,
    `Duration ms: ${result?.durationMs ?? 0}`,
    "",
    "STDOUT:",
    result?.stdout || "",
    "",
    "STDERR summary:",
    summarizeStderr(result?.stderr),
  ].join("\n");
}

function conflictPathsFromConflict(conflict) {
  return normalizeLockPathList(conflict?.overlap || conflict?.paths || []);
}

function formatRejectedExecution({
  headline = "Execution rejected.",
  errorType = "execution_rejected",
  reason,
  requestedAgent = "unknown",
  actualAgent = "none",
  lockMode = "unknown",
  durationMs = 0,
  conflictingPaths = [],
  lockedPaths = [],
  allowedEdits = [],
  runId = "",
  rollback = "",
  disallowedFiles = [],
  serialOnlyMatches = [],
  rollbackFiles = [],
  unresolvedFiles = [],
  fallback = null,
  fallbackReason = "",
  suggestedFix = "Review the request and retry with a bounded task.",
}) {
  const conflicts = normalizeLockPathList(conflictingPaths);
  return [
    headline,
    "",
    `errorType: ${errorType}`,
    `requestedAgent: ${requestedAgent || "unknown"}`,
    `actualAgent: ${actualAgent || "none"}`,
    fallback === null ? null : `fallback: ${fallback ? "yes" : "no"}`,
    fallbackReason ? `fallbackReason: ${fallbackReason}` : null,
    `reason: ${reason || headline}`,
    `suggestedFix: ${suggestedFix}`,
    `lockMode: ${lockMode || "unknown"}`,
    `durationMs: ${durationMs}`,
    `conflictingPaths: ${conflicts.length ? conflicts.join(", ") : "none"}`,
    lockedPaths.length ? `lockedPaths: ${normalizeLockPathList(lockedPaths).join(", ")}` : null,
    allowedEdits.length ? `allowedEdits: ${normalizeLockPathList(allowedEdits).join(", ")}` : null,
    runId ? `runId: ${runId}` : null,
    rollback ? `rollback: ${rollback}` : null,
    disallowedFiles.length ? `disallowedFiles: ${normalizeLockPathList(disallowedFiles).join(", ")}` : null,
    serialOnlyMatches.length ? `serialOnlyMatches: ${serialOnlyMatches.join(", ")}` : null,
    rollbackFiles.length ? `rollbackFiles: ${normalizeLockPathList(rollbackFiles).join(", ")}` : null,
    unresolvedFiles.length ? `unresolvedFiles: ${normalizeLockPathList(unresolvedFiles).join(", ")}` : null,
  ].filter(Boolean).join("\n");
}

async function gitChangedFiles(cwd) {
  const diff = await runCommand("git", ["diff", "--name-only"], cwd, 1000 * 15);
  if (diff.exitCode !== 0) {
    return [];
  }

  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd, 1000 * 15);
  return [
    ...new Set(
      [diff.stdout, untracked.stdout]
        .join("\n")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].sort();
}

async function fileFingerprint(cwd, file) {
  const base = cwd || process.cwd();
  try {
    const content = await readFile(path.resolve(base, file));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "missing";
  }
}

async function gitChangedFileSnapshot(cwd) {
  const files = await gitChangedFiles(cwd);
  const snapshot = new Map();
  for (const file of files) {
    snapshot.set(file, await fileFingerprint(cwd, file));
  }
  return snapshot;
}

function changedFilesBetween(before, after) {
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  return files.filter((file) => before.get(file) !== after.get(file));
}

function isAbsolutePathLike(value) {
  const raw = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/");
}

function comparePathCandidates(value, cwd = "") {
  const raw = normalizeLockPath(value);
  if (!raw) {
    return [];
  }

  const candidates = [raw];
  if (cwd && !isAbsolutePathLike(raw)) {
    candidates.push(path.resolve(cwd, raw));
  }

  return [
    ...new Set(
      candidates.map((candidate) =>
        candidate.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase()
      )
    ),
  ];
}

function isWithinAnyPath(file, allowedPaths = [], cwd = "") {
  const fileCandidates = comparePathCandidates(file, cwd);
  return allowedPaths.some((allowed) => {
    const allowedCandidates = comparePathCandidates(allowed, cwd);
    return fileCandidates.some((normalizedFile) =>
      allowedCandidates.some(
        (normalizedAllowed) => /[*?[\]{}!]/.test(normalizedAllowed)
          ? globToRegex(normalizedAllowed).test(normalizedFile)
          : normalizedFile === normalizedAllowed || normalizedFile.startsWith(`${normalizedAllowed}/`)
      )
    );
  });
}

function unsafeChangedFiles(changedFiles, allowedPaths = [], cwd = "") {
  if (!allowedPaths.length) {
    return changedFiles;
  }
  return changedFiles.filter((file) => !isWithinAnyPath(file, allowedPaths, cwd));
}

async function readFileIfExists(filePath) {
  try {
    return { exists: true, content: await readFile(filePath) };
  } catch {
    return { exists: false, content: null };
  }
}

async function captureRollbackBaseline(cwd) {
  const base = cwd || process.cwd();
  const files = await gitChangedFiles(base);
  const preExisting = new Map();
  for (const file of files) {
    preExisting.set(file, await readFileIfExists(path.resolve(base, file)));
  }
  return { cwd: base, preExisting };
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function restoreFromGitHead(cwd, file) {
  try {
    const result = await execFileAsync("git", ["show", `HEAD:${file.replace(/\\/g, "/")}`], {
      cwd: cwd || process.cwd(),
      shell: false,
      timeout: 1000 * 15,
      maxBuffer: 1024 * 1024 * 30,
      encoding: "buffer",
    });
    const target = path.resolve(cwd || process.cwd(), file);
    await ensureParentDir(target);
    await writeFile(target, result.stdout);
    return true;
  } catch {
    return false;
  }
}

async function rollbackUnsafeChanges({ cwd, baseline, files }) {
  const base = cwd || process.cwd();
  const rollbackFiles = [];
  const unresolvedFiles = [];
  const uniqueFiles = normalizeLockPathList(files);

  for (const file of uniqueFiles) {
    const target = path.resolve(base, file);
    const before = baseline?.preExisting?.get(file);
    try {
      if (before) {
        if (before.exists) {
          await ensureParentDir(target);
          await writeFile(target, before.content);
        } else {
          await rm(target, { recursive: true, force: true });
        }
        rollbackFiles.push(file);
        continue;
      }

      if (await restoreFromGitHead(base, file)) {
        rollbackFiles.push(file);
        continue;
      }

      await rm(target, { recursive: true, force: true });
      rollbackFiles.push(file);
    } catch {
      unresolvedFiles.push(file);
    }
  }

  return {
    rollback: unresolvedFiles.length ? (rollbackFiles.length ? "partial" : "failed") : uniqueFiles.length ? "success" : "not_needed",
    rollbackFiles,
    unresolvedFiles,
  };
}

function scopeChangedFileViolations(changedFiles = [], lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  if (!scopeContract) {
    return {
      outsideWriteScope: [],
      forbiddenFiles: [],
      readOnlyChangedFiles: [],
    };
  }

  const readOnlyChangedFiles = scopeContract.validation.readOnlyMustNotChangeFiles
    && (scopeContract.mode === "read" || lockPlan.lockType === "read")
    ? normalizeLockPathList(changedFiles)
    : [];
  const outsideWriteScope = scopeContract.validation.changedFilesMustBeWithinWriteScope
    && scopeContract.mode === "write"
    ? unsafeChangedFiles(changedFiles, scopeContract.scope.write, lockPlan.cwd)
    : [];
  const forbiddenFiles = scopeContract.validation.forbiddenFilesMustNotChange
    ? changedFiles.filter((file) => isWithinAnyPath(file, scopeContract.scope.forbidden, lockPlan.cwd))
    : [];

  return {
    outsideWriteScope: normalizeLockPathList(outsideWriteScope),
    forbiddenFiles: normalizeLockPathList(forbiddenFiles),
    readOnlyChangedFiles: normalizeLockPathList(readOnlyChangedFiles),
  };
}

function changedFileValidationErrorType(validation) {
  if (validation.scopeViolations?.forbiddenFiles?.length) {
    return "scope_forbidden_file_violation";
  }
  if (validation.scopeViolations?.outsideWriteScope?.length || validation.scopeViolations?.readOnlyChangedFiles?.length) {
    return "scope_changed_file_violation";
  }
  return "changed_file_validation_error";
}

function validateChangedFilesForPlan({ changedFiles = [], lockPlan, parallel = false }) {
  const disallowedFiles = [];
  const serialOnlyMatches = parallel ? findSerialOnlyMatches(changedFiles) : [];
  const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);

  if (lockPlan.lockType === "read" && changedFiles.length) {
    disallowedFiles.push(...changedFiles);
  }

  if (lockPlan.lockType === "write") {
    disallowedFiles.push(...unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd));
  }

  disallowedFiles.push(...changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd)));
  disallowedFiles.push(...scopeViolations.outsideWriteScope, ...scopeViolations.forbiddenFiles, ...scopeViolations.readOnlyChangedFiles);
  disallowedFiles.push(...changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd)));
  if (serialOnlyMatches.length) {
    disallowedFiles.push(...changedFiles.filter((file) => findSerialOnlyMatches([file]).length));
  }

  return {
    disallowedFiles: normalizeLockPathList(disallowedFiles),
    serialOnlyMatches,
    scopeViolations,
  };
}

function safeNamePart(value, fallback = "item") {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

function makeQueueJobId(agent = "agent") {
  return `${safeNamePart(agent, "agent")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function truncateText(value, limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

function resolveWorktreeRoot(repoRoot) {
  const configured = String(CONFIG.worktreeRoot || ".codex-worktrees").trim();
  if (!configured || /[\x00-\x1F\x7F]/.test(configured) || configured.startsWith("~")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Unsafe worktree root: ${JSON.stringify(configured)}`,
    };
  }

  const normalized = configured.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: `Worktree root must not contain parent traversal: ${JSON.stringify(configured)}`,
    };
  }

  const resolved = path.resolve(path.isAbsolute(configured) ? configured : path.join(repoRoot, configured));
  if (resolved === path.parse(resolved).root) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Worktree root resolved to a filesystem root.",
    };
  }

  return { ok: true, root: resolved };
}

function shouldUseWorktree(job, lockPlan) {
  if (job.dryRun || !lockPlan) {
    return false;
  }

  if (CONFIG.worktreeMode === "all") {
    return true;
  }

  return CONFIG.worktreeMode === "write" && lockPlan.lockType === "write";
}

function makeWorktreeBranchName(agent, jobId) {
  return [
    safeNamePart(CONFIG.worktreeBranchPrefix, "agent"),
    safeNamePart(agent, "agent"),
    safeNamePart(jobId, "job"),
  ].join("/");
}

async function createWorktreeForJob({ cwd, agent, jobId }) {
  const baseCwd = cwd || process.cwd();
  const gitVersion = await runCommand("git", ["--version"], baseCwd, 1000 * 15);
  if (gitVersion.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: gitVersion.stderr || "git is not available.",
    };
  }

  const repoRootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], baseCwd, 1000 * 15);
  if (repoRootResult.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_git_not_available",
      error: repoRootResult.stderr || "Current working directory is not inside a Git repository.",
    };
  }

  const repoRoot = path.resolve(repoRootResult.stdout.trim());
  const rootResult = resolveWorktreeRoot(repoRoot);
  if (!rootResult.ok) {
    return rootResult;
  }

  const branch = makeWorktreeBranchName(agent, jobId);
  const worktreePath = path.resolve(rootResult.root, `${safeNamePart(agent, "agent")}-${safeNamePart(jobId, "job")}`);
  if (!isPathInside(rootResult.root, worktreePath) || path.resolve(worktreePath) === repoRoot) {
    return {
      ok: false,
      errorType: "worktree_path_unsafe",
      error: "Generated worktree path is outside the configured worktree root or matches the main repository.",
    };
  }

  await mkdir(rootResult.root, { recursive: true });
  const branchExists = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repoRoot, 1000 * 15);
  if (branchExists.exitCode === 0) {
    return {
      ok: false,
      errorType: "worktree_checkout_failed",
      error: `Worktree branch already exists: ${branch}`,
    };
  }

  const created = await runCommand("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], repoRoot, 1000 * 60);
  if (created.exitCode !== 0) {
    return {
      ok: false,
      errorType: "worktree_create_failed",
      error: created.stderr || created.stdout || "git worktree add failed.",
      repoRoot,
      branch,
      path: worktreePath,
    };
  }

  return {
    ok: true,
    repoRoot,
    path: worktreePath,
    branch,
    cleanup: "not_attempted",
  };
}

async function collectWorktreeDiff(worktree) {
  if (!worktree?.path) {
    return null;
  }

  const changedFiles = await gitChangedFiles(worktree.path);
  const diffStat = await runCommand("git", ["diff", "--stat", "HEAD", "--"], worktree.path, 1000 * 15);
  const diffPatch = await runCommand("git", ["diff", "--binary", "HEAD", "--"], worktree.path, 1000 * 30);
  return {
    changedFiles,
    diffStat: diffStat.exitCode === 0 ? diffStat.stdout.trim() : "",
    patchPreview: diffPatch.exitCode === 0 ? truncateText(diffPatch.stdout) : "",
  };
}

async function cleanupWorktree(worktree, cleanupMode, success) {
  if (!worktree?.path || cleanupMode === "never") {
    return {
      cleanup: "skipped",
      reason: cleanupMode === "never" ? "configured never" : "no worktree",
    };
  }

  if (cleanupMode === "on_success" && !success) {
    return {
      cleanup: "skipped",
      reason: "job did not finish successfully",
    };
  }

  const removeArgs = ["worktree", "remove"];
  if (cleanupMode === "always" || cleanupMode === "on_success") {
    removeArgs.push("--force");
  }
  removeArgs.push(worktree.path);

  const removed = await runCommand("git", removeArgs, worktree.repoRoot, 1000 * 60);
  if (removed.exitCode !== 0) {
    return {
      cleanup: "failed",
      errorType: "worktree_cleanup_failed",
      error: removed.stderr || removed.stdout || "git worktree remove failed.",
    };
  }

  const deletedBranch = await runCommand("git", ["branch", "-D", worktree.branch], worktree.repoRoot, 1000 * 30);
  return {
    cleanup: deletedBranch.exitCode === 0 ? "success" : "partial",
    branchCleanup: deletedBranch.exitCode === 0 ? "success" : "failed",
    error: deletedBranch.exitCode === 0 ? "" : deletedBranch.stderr || deletedBranch.stdout || "git branch cleanup failed.",
  };
}

function formatWorktreeSummary(worktree, cleanupResult = null) {
  if (!worktree) {
    return "Worktree: not used";
  }

  return [
    "Worktree: used",
    `Worktree path: ${worktree.path}`,
    `Worktree branch: ${worktree.branch}`,
    `Worktree cleanup: ${cleanupResult?.cleanup || "not attempted"}`,
    cleanupResult?.reason ? `Worktree cleanup reason: ${cleanupResult.reason}` : null,
    cleanupResult?.error ? `Worktree cleanup error: ${cleanupResult.error}` : null,
  ].filter(Boolean).join("\n");
}

async function recordChangedFiles(runId, cwd, changedFiles, disallowedFiles = []) {
  if (!runId) {
    return;
  }

  const db = await openLockDb(cwd);
  try {
    const disallowed = new Set(normalizeLockPathList(disallowedFiles));
    const insert = db.prepare("INSERT INTO changed_files (run_id, path, allowed) VALUES (?, ?, ?)");
    for (const file of normalizeLockPathList(changedFiles)) {
      insert.run(runId, file, disallowed.has(file) ? 0 : 1);
    }
  } finally {
    closeDb(db);
  }
}

function lockPaths(lock) {
  return normalizeLockPathList(lock.paths || lock.lockedPaths || lock.allowedEdits || []);
}

function conflictsWithActiveLock(request, activeLock) {
  const requestType = request.lockType;
  const activeType = activeLock.lockType;

  if (requestType === "read" && activeType === "read") {
    return null;
  }

  const overlap = overlaps(lockPaths(request), lockPaths(activeLock));
  return overlap
    ? {
        lockId: activeLock.id,
        owner: activeLock.owner,
        agent: activeLock.agent,
        lockType: activeLock.lockType,
        paths: lockPaths(activeLock),
        overlap,
        expiresAt: activeLock.expiresAt,
      }
    : null;
}

function makeLockId(owner, agent) {
  const safeOwner = String(owner || "unknown").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  const safeAgent = String(agent || "agent").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${safeOwner}-${safeAgent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeLockToken() {
  return randomBytes(32).toString("hex");
}

function stateDbPath(cwd = "") {
  const root = cwd ? path.resolve(cwd) : "";
  if (root && root !== path.parse(root).root) {
    return path.join(root, ".mcp", "bridge-state.sqlite");
  }
  return path.join(GLOBAL_BRIDGE_STATE_DIR, "bridge-state.sqlite");
}

async function openLockDb(cwd = "") {
  const dbPath = stateDbPath(cwd);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS locks (
      normalized_path TEXT PRIMARY KEY,
      owner_agent TEXT NOT NULL,
      run_id TEXT NOT NULL,
      token TEXT NOT NULL,
      lock_mode TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      cwd TEXT,
      task TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      lock_mode TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS changed_files (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      allowed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opencode_jobs (
      job_id TEXT PRIMARY KEY,
      cwd TEXT,
      status TEXT NOT NULL,
      agent TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      record_json TEXT NOT NULL
    );
  `);
  return db;
}

function closeDb(db) {
  try {
    db.close();
  } catch {
    // Nothing useful to do during cleanup.
  }
}

function rowsToLocks(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.run_id}:${row.token}`;
    const lock = grouped.get(key) || {
      id: row.run_id,
      runId: row.run_id,
      token: row.token,
      owner: row.owner_agent,
      agent: row.owner_agent,
      lockType: row.lock_mode,
      lockMode: row.lock_mode,
      paths: [],
      cwd: row.cwd || "",
      task: row.task || "",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    lock.paths.push(row.normalized_path);
    grouped.set(key, lock);
  }
  return [...grouped.values()].map((lock) => ({ ...lock, paths: normalizeLockPathList(lock.paths) }));
}

function listLocksFromDb(db, now = Date.now()) {
  db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(now);
  return rowsToLocks(db.prepare("SELECT * FROM locks WHERE expires_at > ? ORDER BY created_at, run_id, normalized_path").all(now));
}

async function cleanupExpiredLocks(cwd = "") {
  const db = await openLockDb(cwd);
  try {
    db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(Date.now());
  } finally {
    closeDb(db);
  }
}

async function listLocks(cwd = "") {
  const db = await openLockDb(cwd);
  try {
    return listLocksFromDb(db);
  } finally {
    closeDb(db);
  }
}

async function acquireHardLock({
  owner = "codex",
  agent = "opencode",
  task = "",
  cwd = "",
  lockType = "write",
  paths = [],
  ttlMs = DEFAULT_LOCK_TTL_MS,
}) {
  const normalizedLockType = String(lockType || "write").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const unsafeReason = unsafePathReason(paths, cwd);
  const lockPathsRequested = normalizeLockPathList(paths);

  if (!PARALLEL_LOCK_TYPES.has(normalizedLockType)) {
    return {
      ok: false,
      error: `Invalid lockType "${lockType}". Use read, write, or serial_integration.`,
    };
  }

  if (!lockPathsRequested.length) {
    return {
      ok: false,
      error: "Write lock rejected: paths are required.",
    };
  }

  if (unsafeReason) {
    return {
      ok: false,
      error: `Write lock rejected: ${unsafeReason}`,
    };
  }

  if (hasAmbiguousPathPattern(lockPathsRequested)) {
    return {
      ok: false,
      error: "Write lock rejected: wildcard or ambiguous paths are not allowed.",
    };
  }

  const db = await openLockDb(cwd);
  const now = Date.now();
  const runId = makeLockId(owner, agent);
  const token = makeLockToken();
  const expiresAt = now + Math.max(1000, Number(ttlMs) || DEFAULT_LOCK_TTL_MS);
  const request = { lockType: normalizedLockType, paths: lockPathsRequested };

  try {
    db.exec("BEGIN IMMEDIATE");
    const keptLocks = listLocksFromDb(db, now);
    const conflict = keptLocks.map((lock) => conflictsWithActiveLock(request, lock)).find(Boolean);
    if (conflict) {
      db.exec("ROLLBACK");
      const conflictPath = normalizeLockPath(conflict.overlap?.[0] || conflict.overlap?.[1] || conflict.paths?.[0] || "");
      return {
        ok: false,
        error: `Write lock conflict on: ${conflictPath || "unknown"}`,
        conflict,
        activeLocks: keptLocks,
      };
    }

    db.prepare(
      "INSERT INTO runs (run_id, agent, status, lock_mode, started_at, finished_at) VALUES (?, ?, ?, ?, ?, NULL)"
    ).run(runId, agent, "running", normalizedLockType, now);
    const insert = db.prepare(
      "INSERT INTO locks (normalized_path, owner_agent, run_id, token, lock_mode, expires_at, created_at, cwd, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const requestedPath of lockPathsRequested) {
      insert.run(requestedPath, agent || owner, runId, token, normalizedLockType, expiresAt, now, cwd || "", String(task || "").slice(0, 500));
    }
    db.exec("COMMIT");

    const lock = {
      id: runId,
      runId,
      token,
      owner,
      agent,
      task: String(task || "").slice(0, 500),
      cwd: cwd || "",
      lockType: normalizedLockType,
      lockMode: normalizedLockType,
      paths: lockPathsRequested,
      createdAt: now,
      expiresAt,
      pid: process.pid,
    };
    return { ok: true, lock, activeLocks: listLocksFromDb(db) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after failed begin/commit.
    }
    return { ok: false, error: `Write lock rejected: ${error.message || String(error)}` };
  } finally {
    closeDb(db);
  }
}

async function releaseHardLock(lockId, token = "", paths = [], cwd = "") {
  if (!lockId) {
    return { ok: false, released: false, error: "lockId is required." };
  }

  if (!token) {
    return { ok: false, released: false, error: "Lock release token is required." };
  }

  const db = await openLockDb(cwd);
  try {
    db.exec("BEGIN IMMEDIATE");
    const requestedPaths = normalizeLockPathList(paths);
    const rows = requestedPaths.length
      ? db.prepare(`SELECT * FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).all(lockId, token, ...requestedPaths)
      : db.prepare("SELECT * FROM locks WHERE run_id = ? AND token = ?").all(lockId, token);
    if (!rows.length) {
      db.exec("ROLLBACK");
      return { ok: false, released: false, error: "No active lock matched that run_id and token." };
    }

    if (requestedPaths.length) {
      db.prepare(`DELETE FROM locks WHERE run_id = ? AND token = ? AND normalized_path IN (${requestedPaths.map(() => "?").join(",")})`).run(lockId, token, ...requestedPaths);
    } else {
      db.prepare("DELETE FROM locks WHERE run_id = ? AND token = ?").run(lockId, token);
    }
    db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?").run("released", Date.now(), lockId);
    db.exec("COMMIT");
    return { ok: true, released: true, activeLocks: listLocksFromDb(db) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors after failed begin/commit.
    }
    return { ok: false, released: false, error: error.message || String(error) };
  } finally {
    closeDb(db);
  }
}

function hardLockPathsForPlan(lockPlan) {
  return firstNonEmptyList(lockPlan.allowedEdits, lockPlan.lockedPaths);
}

function hardLockSummary(acquiredLock) {
  if (!acquiredLock) {
    return "not acquired";
  }

  return `${acquiredLock.id} (${acquiredLock.lockType}: ${acquiredLock.paths.join(", ")})`;
}

function validateDelegationPlanInputs(jobs) {
  if (!Array.isArray(jobs) || jobs.length < 1) {
    return {
      error: "At least one delegation job is required.",
      lockPlans: [],
      conflictingPaths: [],
      executionMode: "none",
    };
  }

  if (jobs.length === 1) {
    const { error, errorType, suggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(jobs[0]);
    return {
      error,
      errorType,
      suggestedFix,
      lockPlans: [lockPlan],
      conflictingPaths: [],
      serialOnlyMatches,
      executionMode: "single",
    };
  }

  const { error, errorType, suggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
  return {
    error,
    errorType,
    suggestedFix,
    lockPlans,
    conflictingPaths,
    serialOnlyMatches,
    executionMode: "parallel",
  };
}

async function findActiveLockConflict(lockPlans) {
  for (const plan of lockPlans) {
    if (plan.lockType === "read") {
      continue;
    }

    const active = await listLocks(plan.cwd);
    const conflict = active
      .map((lock) =>
        conflictsWithActiveLock(
          {
            lockType: plan.lockType,
            paths: hardLockPathsForPlan(plan),
          },
          lock
        )
      )
      .find(Boolean);

    if (conflict) {
      return { plan, conflict };
    }
  }

  return null;
}

function formatDelegationPlanJob({ index, job, lockPlan, resolution }) {
  const timeoutMs = timeoutForAgent(resolution?.actualAgent || lockPlan.agent, lockPlan, lockPlan.timeoutMs);
  return [
    `JOB ${index + 1}`,
    `Requested agent: ${resolution?.requestedAgent || lockPlan.agent}`,
    `Requested agent mode: ${resolution?.requestedAgentMode || "unknown"}`,
    `Actual agent: ${resolution?.actualAgent || "none"}`,
    `Actual agent mode: ${resolution?.actualAgentMode || resolution?.requestedAgentMode || "unknown"}`,
    `Fallback used: ${resolution?.fallbackUsed ? "yes" : "no"}`,
    resolution?.fallbackReason ? `Fallback reason: ${resolution.fallbackReason}` : null,
    `Subagent proxy used: ${resolution?.proxyUsed ? "yes" : "no"}`,
    `Subagent strategy: ${resolution?.subagentStrategy || job.subagentStrategy || "proxy"}`,
    resolution?.proxyReason ? `Proxy reason: ${resolution.proxyReason}` : null,
    `Would run: ${resolution?.actualAgent ? commandShape(resolution.actualAgent) : "no"}`,
    `Would acquire lock: ${lockPlan.lockType === "read" ? "no" : "yes"}`,
    `Lock mode: ${lockPlan.lockMode}`,
    `Lock type: ${lockPlan.lockType}`,
    lockPlan.orchestratorMode ? `Orchestrator mode: ${lockPlan.orchestratorMode}` : null,
    `Timeout ms: ${timeoutMs}`,
    `Lock granted: ${lockPlan.lockedPaths.length ? lockPlan.lockedPaths.join(", ") : "not specified"}`,
    `Allowed edits: ${lockPlan.allowedEdits.length ? lockPlan.allowedEdits.join(", ") : "none"}`,
    `Forbidden edits: ${lockPlan.forbiddenEdits.length ? lockPlan.forbiddenEdits.join(", ") : "none specified"}`,
    `Shared files frozen: ${lockPlan.sharedFiles.length ? lockPlan.sharedFiles.join(", ") : "none specified"}`,
    `Validation command: ${lockPlan.validationCommand || "not specified"}`,
  ].filter(Boolean).join("\n");
}

server.tool(
  "acquire_agent_lock",
  "Acquire a temporary file/path lock for exceptional delegated-agent coordination.",
  {
    owner: z.string().optional().describe("Lock owner, usually Codex."),
    agent: z.string().optional().describe("Agent receiving the lock."),
    task: z.string().optional().describe("Short task description."),
    cwd: z.string().optional().describe("Repository path."),
    lockType: z.enum(["read", "write", "serial_integration"]).optional(),
    paths: z.array(z.string()).min(1).describe("Concrete files or directories to lock."),
    ttlMs: z.number().int().positive().optional().describe("Lease duration in milliseconds. Defaults to 30 minutes."),
  },
  async ({ owner = "codex", agent = "opencode", task = "", cwd = "", lockType = "write", paths, ttlMs = DEFAULT_LOCK_TTL_MS }) => {
    const result = await acquireHardLock({ owner, agent, task, cwd, lockType, paths, ttlMs });
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                "Temporary lock acquired.",
                "",
                `Lock id: ${result.lock.id}`,
                `Release token: ${result.lock.token}`,
                `Owner: ${result.lock.owner}`,
                `Agent: ${result.lock.agent}`,
                `Type: ${result.lock.lockType}`,
                `Paths: ${result.lock.paths.join(", ")}`,
                `Expires at: ${new Date(result.lock.expiresAt).toISOString()}`,
              ].join("\n")
            : [
                "Temporary lock rejected.",
                "",
                result.error,
                result.conflict ? `Conflict: ${JSON.stringify(result.conflict, null, 2)}` : "",
              ].filter(Boolean).join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "release_agent_lock",
  "Release a temporary agent lock by id.",
  {
    lockId: z.string().describe("Lock id returned by acquire_agent_lock or an OpenCode run result."),
    token: z.string().optional().describe("Release token returned by acquire_agent_lock."),
    cwd: z.string().optional().describe("Repository path for the lock registry."),
  },
  async ({ lockId, token = "", cwd = "" }) => {
    const result = await releaseHardLock(lockId, token, [], cwd);
    return {
      content: [
        {
          type: "text",
          text: result.ok
            ? [
                result.released ? "Temporary lock released." : "No active temporary lock matched that id.",
                "",
                `Lock id: ${lockId}`,
                `Active locks remaining: ${result.activeLocks.length}`,
              ].join("\n")
            : ["Temporary lock release failed.", "", result.error].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_agent_locks",
  "List active temporary agent locks.",
  {
    cwd: z.string().optional().describe("Repository path for the lock registry."),
  },
  async ({ cwd = "" }) => {
    const locks = await listLocks(cwd);

    return {
      content: [
        {
          type: "text",
          text: locks.length
            ? [
                "Active temporary locks:",
                "",
                ...locks.map((lock) =>
                  [
                    `- ${lock.id}`,
                    `  owner: ${lock.owner}`,
                    `  agent: ${lock.agent}`,
                    `  type: ${lock.lockType}`,
                    `  paths: ${lock.paths.join(", ")}`,
                    `  expires: ${new Date(lock.expiresAt).toISOString()}`,
                  ].join("\n")
                ),
              ].join("\n")
            : "No active temporary locks.",
        },
      ],
    };
  }
);

server.tool(
  "list_opencode_agents",
  "List available OpenCode agents and subagents.",
  {
    cwd: z.string().optional(),
  },
  async ({ cwd }) => {
    const result = await runCommand(OPENCODE_EXE, ["agent", "list"], cwd, 1000 * 30);

    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode agents:",
            "",
            result.stdout || result.stderr || "No output returned.",
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "validate_delegation_plan",
  "Preflight a single or parallel OpenCode delegation plan without running OpenCode agents or acquiring locks.",
  {
    jobs: z.array(
      z.object({
        agent: z.string(),
        task: z.string(),
        cwd: z.string().optional(),
        allowFallbackToBuild: z.boolean().optional(),
        subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional().describe("OpenCode orchestrator large task mode."),
        role: z.string().optional().describe("Optional Scope Contract role label."),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
        scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
        actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
        validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
        timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
        scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
        write: z.boolean().optional().describe("Whether this job may edit files. Write jobs require lockedPaths."),
        lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
        lockType: z.string().optional().describe("read, write, or serial_integration."),
        timeoutMs: z.number().int().positive().optional().describe("Optional per-job timeout in milliseconds."),
        lockedPaths: z.array(z.string()).optional().describe("Paths to lock. Wildcard suffixes like apps/web/** are normalized to apps/web."),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        delegation: z
          .object({
            scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
            role: z.string().optional(),
            mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
            actions: z.array(z.string()).optional(),
            validation: scopeValidationSchema.optional(),
            timeoutPolicy: scopeTimeoutPolicySchema.optional(),
            scopeContract: scopeContractSchema.optional(),
            lockMode: z.string().optional(),
            lockType: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
            orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional(),
            lockedPaths: z.array(z.string()).optional(),
            allowedEdits: z.array(z.string()).optional(),
            forbiddenEdits: z.array(z.string()).optional(),
            sharedFiles: z.array(z.string()).optional(),
            permissions: z.string().optional(),
            validationCommand: z.string().optional(),
            returnFormat: z.string().optional(),
          })
          .optional(),
      })
    ).min(1),
  },
  async ({ jobs }) => {
    const toolStarted = nowMs();
    const { error: planError, errorType: planErrorType, suggestedFix: planSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [], executionMode } = validateDelegationPlanInputs(jobs);
    const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "unknown";
    const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";

    if (planError) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: planErrorType || (executionMode === "parallel" ? "parallel_plan_rejected" : "lock_plan_rejected"),
              reason: planError,
              requestedAgent: requestedAgents,
              actualAgent: "none",
              lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths,
              serialOnlyMatches,
              suggestedFix: planSuggestedFix || "Adjust agents, lockMode, lockedPaths, allowedEdits, or split overlapping write work into serial steps.",
            }),
          },
        ],
      };
    }

    const activeConflict = await findActiveLockConflict(lockPlans);
    if (activeConflict) {
      const conflictPaths = conflictPathsFromConflict(activeConflict.conflict);
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Delegation plan rejected.",
              errorType: "write_lock_conflict",
              reason: `Write lock conflict on: ${conflictPaths[0] || "unknown"}`,
              requestedAgent: activeConflict.plan.agent,
              actualAgent: "none",
              lockMode: activeConflict.plan.lockMode,
              durationMs: nowMs() - toolStarted,
              conflictingPaths: conflictPaths,
              suggestedFix: "Wait for the active lock to expire, release it if it is stale, or choose a non-overlapping lockedPaths scope.",
            }),
          },
        ],
      };
    }

    const queueAssessment = assessQueuePlan(lockPlans);
    const plannedJobs = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const resolution = await resolveAgent(
        job.agent,
        job.cwd,
        job.allowFallbackToBuild || false,
        job.subagentStrategy || "proxy",
        job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT
      );

      if (resolution.error) {
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Delegation plan rejected.",
                errorType: "agent_routing_error",
                reason: resolution.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: "none",
                fallback: resolution.fallbackUsed,
                fallbackReason: resolution.fallbackReason,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
              }),
            },
          ],
        };
      }

      plannedJobs.push(formatDelegationPlanJob({ index, job, lockPlan, resolution }));
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "Delegation plan accepted.",
            "",
            `Execution mode: ${executionMode}`,
            `Jobs: ${jobs.length}`,
            `Queue status: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
            `Queue conflicting paths: ${queueAssessment.conflictingPaths.length ? queueAssessment.conflictingPaths.join(", ") : "none"}`,
            "OpenCode agents will not run during this preflight.",
            "Temporary locks were not acquired.",
            "",
            ...plannedJobs,
          ].join("\n\n"),
        },
      ],
    };
  }
);

server.tool(
  "run_opencode_agent",
  "Run one OpenCode agent/subagent with a task prompt.",
  {
    agent: z.string().describe("Agent name, for example planner, architect, builder, reviewer, tester, or explore."),
    task: z.string().describe("Task prompt to send to the OpenCode agent."),
    cwd: z.string().optional().describe("Repository path where OpenCode should run."),
    allowFallbackToBuild: z.boolean().optional().describe("Use build only when the requested agent is missing. Defaults to false."),
    subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional().describe("How to handle OpenCode agents listed as subagent. Defaults to proxy because OpenCode CLI may not run subagents as top-level agents."),
    proxyAgent: z.string().optional().describe("Primary/all OpenCode agent used when subagentStrategy is proxy. Defaults to build."),
    orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional().describe("OpenCode orchestrator large task mode. planning-only never writes; bounded-writer is one isolated writer with explicit lockedPaths and allowedEdits."),
    role: z.string().optional().describe("Optional Scope Contract role label."),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
    scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
    actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
    validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
    timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
    scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
    dryRun: z.boolean().optional().describe("Validate routing and command construction without running OpenCode."),
    write: z.boolean().optional().describe("Whether this job may edit files. Write jobs receive a temporary MCP-managed lock."),
    lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
    lockType: z.string().optional().describe("read, write, or serial_integration."),
    timeoutMs: z.number().int().positive().optional().describe("Optional per-run timeout in milliseconds."),
    lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner. Wildcard suffixes like apps/web/** are normalized to apps/web."),
    ownedPaths: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    sharedFiles: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    delegation: z
      .object({
        scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
        role: z.string().optional(),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
        actions: z.array(z.string()).optional(),
        validation: scopeValidationSchema.optional(),
        timeoutPolicy: scopeTimeoutPolicySchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional(),
        lockedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        permissions: z.string().optional(),
        validationCommand: z.string().optional(),
        returnFormat: z.string().optional(),
      })
      .optional()
      .describe("Optional compact delegation packet fields to avoid sending unrelated context."),
  },
  async ({
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "proxy",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    orchestratorMode,
    role,
    mode,
    scope,
    actions,
    validation: scopeValidation,
    timeoutPolicy,
    scopeContract,
    dryRun = false,
    write,
    lockType,
    lockMode,
    timeoutMs,
    lockedPaths,
    ownedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    validationCommand,
    delegation,
  }) => {
    const toolStarted = nowMs();
    const requestedJob = {
      agent,
      task,
      cwd,
      dryRun,
      orchestratorMode,
      role,
      mode,
      scope,
      actions,
      validation: scopeValidation,
      timeoutPolicy,
      scopeContract,
      write,
      lockMode,
      lockType,
      timeoutMs,
      lockedPaths,
      ownedPaths,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      validationCommand,
      delegation,
    };
    const execution = await executeOpenCodeJob(requestedJob, { toolStarted });
    return execution.response;
  }
);

server.tool(
  "enqueue_opencode_job",
  "Enqueue one OpenCode job for MCP-managed scheduling. Uses the same validation as run_opencode_agent.",
  {
    parentJobId: z.string().optional(),
    agent: z.string().describe("Agent name, for example planner, architect, builder, reviewer, tester, or explore."),
    task: z.string().describe("Task prompt to send to the OpenCode agent."),
    cwd: z.string().optional().describe("Repository path where OpenCode should run."),
    allowFallbackToBuild: z.boolean().optional().describe("Use build only when the requested agent is missing. Defaults to false."),
    subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
    proxyAgent: z.string().optional(),
    orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional().describe("OpenCode orchestrator large task mode."),
    role: z.string().optional().describe("Optional Scope Contract role label."),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
    scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
    actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
    validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
    timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
    scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
    dryRun: z.boolean().optional().describe("Validate routing and command construction without running OpenCode."),
    write: z.boolean().optional().describe("Whether this job may edit files. Write jobs receive a temporary MCP-managed lock."),
    lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
    lockType: z.string().optional().describe("read, write, or serial_integration."),
    timeoutMs: z.number().int().positive().optional().describe("Optional per-run timeout in milliseconds."),
    lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner."),
    ownedPaths: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    sharedFiles: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    delegation: z
      .object({
        scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
        role: z.string().optional(),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
        actions: z.array(z.string()).optional(),
        validation: scopeValidationSchema.optional(),
        timeoutPolicy: scopeTimeoutPolicySchema.optional(),
        scopeContract: scopeContractSchema.optional(),
        lockMode: z.string().optional(),
        lockType: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional(),
        lockedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        permissions: z.string().optional(),
        validationCommand: z.string().optional(),
        returnFormat: z.string().optional(),
      })
      .optional(),
  },
  async ({ parentJobId = "", ...job }) => {
    const started = nowMs();
    const enqueued = await enqueueQueueJob(job, parentJobId);
    if (!enqueued.ok) {
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              headline: "Queue job rejected.",
              errorType: enqueued.errorType || "queue_rejected",
              reason: enqueued.error,
              requestedAgent: job.agent,
              actualAgent: "none",
              lockMode: enqueued.lockPlan?.lockMode || job.lockMode || "unknown",
              durationMs: nowMs() - started,
              serialOnlyMatches: enqueued.serialOnlyMatches || [],
              suggestedFix: enqueued.suggestedFix || "Fix the job contract and enqueue again.",
            }),
          },
        ],
      };
    }

    const queueAssessment = assessQueuePlan([{
      lockType: enqueued.record.mode === "read" ? "read" : "write",
      cwd: enqueued.record.cwd,
      lockedPaths: enqueued.record.lockedPaths,
      allowedEdits: enqueued.record.allowedEdits,
    }]);
    return {
      content: [
        {
          type: "text",
          text: [
            "OpenCode job enqueued.",
            `Job ID: ${enqueued.record.jobId}`,
            `Status: ${enqueued.record.status}`,
            `Agent: ${enqueued.record.agent}`,
            `Mode: ${enqueued.record.mode}`,
            `Lock mode: ${enqueued.record.lockMode}`,
            `Locked paths: ${enqueued.record.lockedPaths.length ? enqueued.record.lockedPaths.join(", ") : "none"}`,
            `Allowed edits: ${enqueued.record.allowedEdits.length ? enqueued.record.allowedEdits.join(", ") : "none"}`,
            `Queue mode: ${CONFIG.queueMode}`,
            `Queue assessment: ${queueAssessment.status}`,
            `Queue reason: ${queueAssessment.reason}`,
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "list_opencode_jobs",
  "List queued OpenCode jobs and their current state.",
  {
    cwd: z.string().optional().describe("Optional repository path for sqlite-backed job listing."),
    status: z.enum(["pending", "planned", "blocked", "running", "validating", "reviewing", "testing", "completed", "failed", "cancelled"]).optional(),
  },
  async ({ cwd = "", status = "" }) => {
    const memoryRecords = [...QUEUE_JOBS.values()]
      .map((record) => queueRecordSnapshot(record, false))
      .filter((record) => !status || record.status === status);
    const persistedRecords = await listPersistedQueueRecords(cwd, status);
    const byId = new Map();
    for (const record of persistedRecords.concat(memoryRecords)) {
      byId.set(record.jobId, record);
    }
    const records = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return {
      content: [
        {
          type: "text",
          text: [
            `Queue mode: ${CONFIG.queueMode}`,
            `Jobs: ${records.length}`,
            JSON.stringify(records, null, 2),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "get_opencode_job",
  "Get one queued OpenCode job, including result text when available.",
  {
    jobId: z.string(),
    cwd: z.string().optional().describe("Optional repository path for sqlite-backed job lookup."),
  },
  async ({ jobId, cwd = "" }) => {
    const record = QUEUE_JOBS.get(jobId);
    const snapshot = record ? queueRecordSnapshot(record) : await readPersistedQueueRecord(jobId, cwd);
    if (!snapshot) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job not found: ${jobId}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(snapshot, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "cancel_opencode_job",
  "Cancel a queued OpenCode job. Pending and blocked jobs are cancelled immediately; running jobs receive a cancellation request.",
  {
    jobId: z.string(),
  },
  async ({ jobId }) => {
    const record = QUEUE_JOBS.get(jobId);
    if (!record) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job not found: ${jobId}`,
          },
        ],
      };
    }

    if (["completed", "failed", "cancelled"].includes(record.status)) {
      return {
        content: [
          {
            type: "text",
            text: `OpenCode queue job ${jobId} is already ${record.status}.`,
          },
        ],
      };
    }

    if (record.status === "running") {
      updateQueueRecord(record, {
        cancellationRequested: true,
        errorReason: "Cancellation requested while running. The current OpenCode process may finish before the queue marks final state.",
      });
      return {
        content: [
          {
            type: "text",
            text: `Cancellation requested for running OpenCode job ${jobId}.`,
          },
        ],
      };
    }

    updateQueueRecord(record, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      errorReason: "Cancelled before execution.",
    });
    scheduleQueue();
    return {
      content: [
        {
          type: "text",
          text: `OpenCode queue job cancelled: ${jobId}`,
        },
      ],
    };
  }
);

function hasWriteIntent(job) {
  if (job.write === true) {
    return true;
  }

  const scopeContract = normalizeScopeContract(job);
  if (scopeContract?.mode === "write" || scopeContract?.scope.write.length) {
    return true;
  }

  if (job.write === false) {
    return false;
  }

  const agent = String(job.agent || "").trim().toLowerCase();
  const allowedEdits = normalizeList(job.allowedEdits).concat(normalizeList(job.delegation?.allowedEdits));
  const permissions = String(job.delegation?.permissions || "");

  if (agent === "debugger" && (!allowedEdits.length || /read-only/i.test(permissions))) {
    return false;
  }

  if (READ_ONLY_PARALLEL_AGENTS.has(agent)) {
    return false;
  }

  return WRITE_CAPABLE_AGENTS.has(agent);
}

function isOrchestratorAgent(agent) {
  return String(agent || "").trim().toLowerCase() === "orchestrator";
}

function requestedOrchestratorMode(job) {
  return String(job.orchestratorMode || job.delegation?.orchestratorMode || "").trim().toLowerCase();
}

function hasOrchestratorBoundedWriterShape(job) {
  const scopeContract = normalizeScopeContract(job);
  return job.write === true
    || scopeContract?.mode === "write"
    || scopeContract?.scope.write.length > 0
    || normalizeList(job.lockedPaths).length > 0
    || normalizeList(job.ownedPaths).length > 0
    || normalizeList(job.allowedEdits).length > 0
    || normalizeList(job.delegation?.lockedPaths).length > 0
    || normalizeList(job.delegation?.allowedEdits).length > 0;
}

function normalizeOrchestratorMode(job) {
  const raw = requestedOrchestratorMode(job);
  if (!raw) {
    if (!isOrchestratorAgent(job.agent)) {
      return "";
    }
    return hasOrchestratorBoundedWriterShape(job) ? "bounded-writer" : "planning-only";
  }
  if (["planning", "planning_only", "plan-only", "plan_only", "readonly", "read-only"].includes(raw)) {
    return "planning-only";
  }
  if (["bounded", "bounded_writer", "bounded-writer", "writer"].includes(raw)) {
    return "bounded-writer";
  }
  return raw;
}

function detectsOrchestratorInternalWriterRequest(task) {
  return /\b(run|spawn|call|invoke|delegate|launch|start|use)\b.{0,50}\b(builder|debugger|writer|write agent|sub-builder|subbuilder|sub-agent|subagent)\b|\b(parallel|concurrent)\b.{0,50}\b(builder|debugger|writer|write agents?)\b/i.test(String(task || ""));
}

function detectsLargeOrchestratorTask(task) {
  const text = String(task || "");
  return /\b(large|complete|entire|full|whole|service|microservice|bounded-writer)\b/i.test(text)
    || /(\bbuild\b|\bimplement\b).{0,80}\b(service|microservice|module|app|feature)\b/i.test(text)
    || /(كبيرة|كاملة|خدمة|سيرفس|مايكروسيرفس|ابني|بناء|نفذ)/i.test(text);
}

function detectsPlanningIntent(task) {
  return /\b(plan|planning|analyze|analyse|architecture|breakdown|proposal)\b|(?:خطط|خطة|حلل|تحليل|قسّم|قسم|معمارية)/i.test(String(task || ""));
}

function findOrchestratorGlobalFileMatches(paths) {
  const normalized = normalizeLockPathList(paths);
  const matches = [...findSerialOnlyMatches(normalized)];
  for (const candidate of normalized) {
    if (/^(packages\/shared|shared)(\/|$)/i.test(candidate)) {
      matches.push(`${candidate} (shared package)`);
    }
  }
  return [...new Set(matches)];
}

function orchestratorPolicyError(job, lockPlan, executionMode = "single") {
  if (!isOrchestratorAgent(job.agent)) {
    return null;
  }

  if (ALLOW_ORCHESTRATOR_WRITE_THROUGH_MCP) {
    return null;
  }

  const mode = lockPlan.orchestratorMode || normalizeOrchestratorMode(job);

  if (detectsOrchestratorInternalWriterRequest(job.task)) {
    return {
      errorType: "orchestrator_internal_writer_forbidden",
      error: "OpenCode orchestrator cannot run, spawn, invoke, or delegate to internal writer agents because nested writers would bypass MCP per-writer locks.",
      suggestedFix: "Use one bounded orchestrator writer inside a single service folder, or split work into direct builder/debugger jobs through MCP Bridge.",
    };
  }

  if (mode === "planning-only") {
    if (job.write === true || lockPlan.lockType !== "read" || lockPlan.lockMode !== "off" || lockPlan.allowedEdits.length) {
      return {
        errorType: "orchestrator_write_forbidden",
        error: "OpenCode orchestrator planning-only mode cannot write files.",
        suggestedFix: "Use orchestratorMode bounded-writer with write true, lockMode simple, lockedPaths, and allowedEdits for one isolated service folder.",
      };
    }
    return null;
  }

  if (mode === "bounded-writer") {
    if (executionMode !== "single") {
      return {
        errorType: "orchestrator_internal_writer_forbidden",
        error: "OpenCode orchestrator bounded-writer mode must run as a single bounded writer, not as one of multiple parallel writers.",
        suggestedFix: "Run the isolated service task as one run_opencode_agent call, then let Codex review and distribute follow-up work.",
      };
    }

    if (job.write !== true || lockPlan.lockType !== "write" || lockPlan.lockMode !== "simple" || !lockPlan.lockedPaths.length || !lockPlan.allowedEdits.length) {
      return {
        errorType: "orchestrator_bounded_writer_missing_scope",
        error: "OpenCode orchestrator bounded-writer mode requires write true, lockMode simple, non-empty lockedPaths, and non-empty allowedEdits.",
        suggestedFix: "Pass write true, lockMode simple, lockedPaths, and allowedEdits for one isolated service folder such as apps/billing.",
      };
    }

    const globalMatches = findOrchestratorGlobalFileMatches(lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.forbiddenEdits, lockPlan.sharedFiles));
    if (globalMatches.length) {
      return {
        errorType: "orchestrator_global_file_requires_planning_only",
        error: "OpenCode orchestrator bounded-writer mode cannot touch root configs, lockfiles, env files, shared packages, or other global/risky paths.",
        suggestedFix: "Use planning-only mode, then let Codex distribute shared/global edits to direct builder/debugger jobs through MCP Bridge.",
        serialOnlyMatches: globalMatches,
      };
    }

    return null;
  }

  return {
    errorType: "orchestrator_large_task_requires_mode",
    error: `Invalid orchestratorMode "${mode}". Use planning-only or bounded-writer.`,
    suggestedFix: "Set orchestratorMode to planning-only or bounded-writer.",
  };
}

function normalizePathForCompare(path) {
  return normalizeLockPath(path).toLowerCase();
}

function hasAmbiguousPathPattern(paths) {
  return normalizeList(paths).some((path) => /[*?[\]{}!]/.test(path));
}

function overlaps(pathsA, pathsB) {
  for (const a of pathsA) {
    for (const b of pathsB) {
      const left = normalizePathForCompare(a);
      const right = normalizePathForCompare(b);
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        return [a, b];
      }
    }
  }
  return null;
}

function normalizeLockType(lockType, job) {
  const raw = String(lockType || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return hasWriteIntent(job) ? "write" : "read";
  }

  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }

  if (raw === "serial" || raw === "integration" || raw === "serial_integration_lock") {
    return "serial_integration";
  }

  return raw;
}

function normalizeLockMode(lockMode, lockType) {
  const raw = String(lockMode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (lockType === "read") {
    return raw && !["none", "off", "read", "read_only", "readonly"].includes(raw) ? raw : CONFIG.defaultReadLockMode;
  }

  if (!raw) {
    return CONFIG.defaultWriteLockMode;
  }

  if (raw === "none" || raw === "read" || raw === "read_only" || raw === "readonly") {
    return "off";
  }

  if (raw === "auto" || raw === "temporary") {
    return CONFIG.defaultWriteLockMode;
  }

  return raw;
}

function createLockPlan(job, index) {
  const lockType = normalizeLockType(job.lockType || job.delegation?.lockType, job);
  const lockMode = normalizeLockMode(job.lockMode || job.delegation?.lockMode, lockType);
  const scopeContract = normalizeScopeContract(job);
  const lockedPaths = firstNonEmptyList(job.lockedPaths, job.ownedPaths, job.delegation?.lockedPaths);
  const allowedEdits = firstNonEmptyList(job.allowedEdits, job.delegation?.allowedEdits, scopeContract?.scope.write);
  const forbiddenEdits = mergePathLists(job.forbiddenEdits, job.delegation?.forbiddenEdits, scopeContract?.scope.forbidden);
  const sharedFiles = firstNonEmptyList(job.sharedFiles, job.delegation?.sharedFiles);
  const orchestratorMode = normalizeOrchestratorMode(job);
  const contractTimeoutMs = scopeContractTimeout(scopeContract, lockType);

  return {
    index,
    agent: job.agent,
    task: job.task,
    cwd: job.cwd || "",
    lockMode,
    lockType,
    orchestratorMode,
    lockedPaths,
    allowedEdits,
    forbiddenEdits,
    sharedFiles,
    scopeContract,
    validationCommand: job.validationCommand || job.delegation?.validationCommand || "",
    timeoutMs: job.timeoutMs || job.delegation?.timeoutMs || contractTimeoutMs || null,
  };
}

function validateScopeContract(job, lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  if (!scopeContract) {
    return null;
  }

  if (scopeContract.agent && scopeContract.agent !== lockPlan.agent) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract agent "${scopeContract.agent}" does not match requested agent "${lockPlan.agent}".`,
      suggestedFix: "Use a Scope Contract for the same agent being delegated.",
    };
  }

  if (!["read", "write"].includes(scopeContract.mode)) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract mode "${scopeContract.mode}" is invalid. Use read or write.`,
      suggestedFix: "Set Scope Contract mode to read or write.",
    };
  }

  const unsafeReason = unsafePathReason(scopeContractPathInputs(scopeContract), lockPlan.cwd || process.cwd());
  if (unsafeReason) {
    return {
      errorType: "scope_path_unsafe",
      error: `Scope Contract has unsafe path input: ${unsafeReason}`,
      suggestedFix: "Use repo-relative bounded paths without parent traversal, home shortcuts, control characters, or outside-repo absolute paths.",
    };
  }

  if (scopeContract.mode === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: "Read-only Scope Contract cannot include write paths.",
      suggestedFix: "Remove scope.write for read-only agents, or change the contract mode and job to write with explicit locks.",
    };
  }

  if (READ_ONLY_PARALLEL_AGENTS.has(String(lockPlan.agent || "").trim().toLowerCase()) && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or delegate write work to builder/debugger with explicit locks.",
    };
  }

  if (lockPlan.lockType === "read" && scopeContract.scope.write.length) {
    return {
      errorType: "scope_readonly_write_scope",
      error: `Read-only agent "${lockPlan.agent}" cannot receive a write scope.`,
      suggestedFix: "Use an empty scope.write for read-only agents, or run a write-capable agent with write true and lockedPaths.",
    };
  }

  if (lockPlan.lockType === "write" && scopeContract.mode !== "write") {
    return {
      errorType: "scope_contract_invalid",
      error: "Write jobs with a Scope Contract must use mode write.",
      suggestedFix: "Set Scope Contract mode to write and provide scope.write paths.",
    };
  }

  if (scopeContract.mode === "write" && !scopeContract.scope.write.length) {
    return {
      errorType: "scope_contract_invalid",
      error: "Write Scope Contract requires non-empty scope.write paths.",
      suggestedFix: "Add bounded scope.write paths or omit the Scope Contract and use legacy lockedPaths/allowedEdits.",
    };
  }

  const forbiddenWriteOverlap = overlaps(scopeContract.scope.write, scopeContract.scope.forbidden);
  if (forbiddenWriteOverlap) {
    return {
      errorType: "scope_write_forbidden",
      error: `Scope Contract write path is forbidden: ${forbiddenWriteOverlap[0]} / ${forbiddenWriteOverlap[1]}.`,
      conflictingPaths: forbiddenWriteOverlap,
      suggestedFix: "Remove the forbidden path from scope.write, or narrow the write scope so forbidden paths are excluded.",
    };
  }

  const forbiddenReadOverlap = overlaps(scopeContract.scope.read, scopeContract.scope.forbidden);
  if (forbiddenReadOverlap) {
    return {
      errorType: "scope_contract_invalid",
      error: `Scope Contract read path overlaps a forbidden path: ${forbiddenReadOverlap[0]} / ${forbiddenReadOverlap[1]}.`,
      conflictingPaths: forbiddenReadOverlap,
      suggestedFix: "Remove forbidden paths from scope.read or narrow the read scope.",
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (scopeContract.scope.write.length && !isWithinAnyPath(allowedPath, scopeContract.scope.write, lockPlan.cwd)) {
      return {
        errorType: "scope_write_forbidden",
        error: `Allowed edit path is outside Scope Contract write paths: ${allowedPath}.`,
        conflictingPaths: [allowedPath],
        suggestedFix: "Keep allowedEdits inside scope.write, or expand scope.write explicitly.",
      };
    }
  }

  return null;
}

function validateParallelWritePlan(jobs) {
  const lockPlans = jobs.map((job, index) => createLockPlan(job, index));
  if (jobs.length > CONFIG.parallelLimit) {
    return {
      error: `Parallel job count ${jobs.length} exceeds CODEX_OPENCODE_PARALLEL_LIMIT ${CONFIG.parallelLimit}.`,
      errorType: "parallel_plan_rejected",
      lockPlans,
    };
  }

  const writePlans = lockPlans.filter((plan) => plan.lockType === "write");
  if (writePlans.length > 1) {
    for (const plan of writePlans) {
      plan.lockMode = CONFIG.defaultParallelWriteLockMode;
    }
  }

  for (const plan of lockPlans) {
    const job = jobs[plan.index];
    const planPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.forbiddenEdits, plan.sharedFiles, scopeContractPathInputs(plan.scopeContract));
    const orchestratorError = orchestratorPolicyError(job, plan, "parallel");
    if (orchestratorError) {
      return {
        ...orchestratorError,
        serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
        lockPlans,
      };
    }

    const scopeError = validateScopeContract(job, plan);
    if (scopeError) {
      return {
        ...scopeError,
        conflictingPaths: scopeError.conflictingPaths || [],
        lockPlans,
      };
    }

    if (!PARALLEL_LOCK_TYPES.has(plan.lockType)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockType "${plan.lockType}". Use read, write, or serial_integration.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    if (!["off", "simple", "strict"].includes(plan.lockMode)) {
      return {
        error: `Parallel job for agent "${plan.agent}" has invalid lockMode "${plan.lockMode}". Use off, simple, or strict.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode off for read-only jobs, simple for one writer, and strict for parallel writers.",
        lockPlans,
      };
    }

    const unsafeReason = unsafePathReason(planPathInputs, plan.cwd);
    if (unsafeReason) {
      return {
        error: `Parallel job for agent "${plan.agent}" has unsafe path input: ${unsafeReason}`,
        errorType: "unsafe_path",
        lockPlans,
      };
    }

    if (plan.lockType !== "read" && plan.lockMode === "off") {
      return {
        error: `Parallel write job for agent "${plan.agent}" cannot use lockMode off.`,
        errorType: "invalid_write_lock_mode",
        suggestedFix: "Use lockMode strict for parallel write jobs.",
        lockPlans,
      };
    }

    if (plan.lockType === "serial_integration") {
      return {
        error: `Parallel job for agent "${plan.agent}" requested a serial integration lock. Serial integration locks must run as a single non-parallel integration step.`,
        errorType: "serial_only_path_in_parallel",
        suggestedFix: "Run this task serially, then run reviewer/tester validation.",
        lockPlans,
      };
    }

    if (plan.lockType === "read") {
      if (job.write === true || plan.allowedEdits.length) {
        return {
          error: `Read-only job for agent "${plan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
          lockPlans,
        };
      }
      continue;
    }

    if (!plan.lockedPaths.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: lockedPaths.`,
        errorType: "missing_locked_paths",
        suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
        lockPlans,
      };
    }

    if (!plan.allowedEdits.length) {
      return {
        error: `Parallel write job for agent "${plan.agent}" is missing required lock fields: allowedEdits.`,
        errorType: "missing_allowed_edits",
        suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
        lockPlans,
      };
    }

    const ambiguousPathInputs = plan.lockedPaths.concat(plan.allowedEdits, plan.sharedFiles, plan.scopeContract?.scope.write || []);
    if (hasAmbiguousPathPattern(ambiguousPathInputs)) {
      return {
        error: `Parallel write job for agent "${plan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks, or run serially.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

    const serialOnlyMatches = findSerialOnlyMatches(plan.lockedPaths.concat(plan.allowedEdits));
    if (serialOnlyMatches.length) {
      return {
        error: "This file or path is global/risky and cannot be edited during parallel execution.",
        errorType: "serial_only_path_in_parallel",
        suggestedFix: "Run this task serially, then run reviewer/tester validation.",
        serialOnlyMatches,
        lockPlans,
      };
    }

    for (const allowedPath of plan.allowedEdits) {
      if (!isWithinAnyPath(allowedPath, plan.lockedPaths, plan.cwd)) {
        return {
          error: `Parallel write job for agent "${plan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
          errorType: "parallel_plan_rejected",
          lockPlans,
        };
      }
    }

    const forbiddenOverlap = overlaps(plan.allowedEdits, plan.forbiddenEdits);
    if (forbiddenOverlap) {
      return {
        error: `Parallel write job for agent "${plan.agent}" allows a forbidden edit path: ${forbiddenOverlap[0]} / ${forbiddenOverlap[1]}.`,
        errorType: "parallel_plan_rejected",
        lockPlans,
      };
    }

  }

  if (writePlans.length > 1) {
    for (let i = 0; i < writePlans.length; i += 1) {
      for (let j = i + 1; j < writePlans.length; j += 1) {
        const overlap = overlaps(
          writePlans[i].allowedEdits.concat(writePlans[i].lockedPaths),
          writePlans[j].allowedEdits.concat(writePlans[j].lockedPaths)
        );
        if (overlap) {
          return {
            error: `Parallel write jobs overlap: "${writePlans[i].agent}" and "${writePlans[j].agent}" both include ${overlap[0]} / ${overlap[1]}.`,
            errorType: "parallel_plan_rejected",
            conflictingPaths: overlap,
            lockPlans,
          };
        }
      }
    }
  }

  return { error: null, lockPlans };
}

function validateSingleLockPlan(job) {
  const lockPlan = createLockPlan(job, 0);
  const planPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.forbiddenEdits, lockPlan.sharedFiles, scopeContractPathInputs(lockPlan.scopeContract));
  const orchestratorError = orchestratorPolicyError(job, lockPlan, "single");
  if (orchestratorError) {
    return {
      ...orchestratorError,
      serialOnlyMatches: orchestratorError.serialOnlyMatches || [],
      lockPlan,
    };
  }

  const scopeError = validateScopeContract(job, lockPlan);
  if (scopeError) {
    return {
      ...scopeError,
      conflictingPaths: scopeError.conflictingPaths || [],
      lockPlan,
    };
  }

  if (!PARALLEL_LOCK_TYPES.has(lockPlan.lockType)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockType "${lockPlan.lockType}". Use read, write, or serial_integration.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  if (!["off", "simple", "strict"].includes(lockPlan.lockMode)) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has invalid lockMode "${lockPlan.lockMode}". Use off, simple, or strict.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode off for read-only jobs and simple/strict for write jobs.",
      lockPlan,
    };
  }

  if (lockPlan.lockType !== "read" && lockPlan.lockMode === "off") {
    return {
      error: `Write job for agent "${lockPlan.agent}" cannot use lockMode off.`,
      errorType: "invalid_write_lock_mode",
      suggestedFix: "Use lockMode simple for a single writer or strict for coordinated writer work.",
      lockPlan,
    };
  }

  const unsafeReason = unsafePathReason(planPathInputs, lockPlan.cwd);
  if (unsafeReason) {
    return {
      error: `OpenCode job for agent "${lockPlan.agent}" has unsafe path input: ${unsafeReason}`,
      errorType: "unsafe_path",
      lockPlan,
    };
  }

  if (lockPlan.lockType === "read") {
    if (job.write === true || lockPlan.allowedEdits.length) {
      return {
        error: `Read-only job for agent "${lockPlan.agent}" cannot request edits. Use write: true with lockedPaths for write work.`,
        errorType: "read_only_edit_forbidden",
        lockPlan,
      };
    }
    return { error: null, lockPlan };
  }

  if (!lockPlan.lockedPaths.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: lockedPaths.`,
      errorType: "missing_locked_paths",
      suggestedFix: "Pass explicit lockedPaths and allowedEdits for every write job.",
      lockPlan,
    };
  }

  if (!lockPlan.allowedEdits.length) {
    return {
      error: `Write job for agent "${lockPlan.agent}" is missing required lock fields: allowedEdits.`,
      errorType: "missing_allowed_edits",
      suggestedFix: "Pass explicit allowedEdits for every write job; do not rely on lockedPaths as the edit allowlist.",
      lockPlan,
    };
  }

  const ambiguousPathInputs = lockPlan.lockedPaths.concat(lockPlan.allowedEdits, lockPlan.sharedFiles, lockPlan.scopeContract?.scope.write || []);
  if (hasAmbiguousPathPattern(ambiguousPathInputs)) {
    return {
      error: `Write job for agent "${lockPlan.agent}" uses wildcard or ambiguous paths. Use concrete file/directory locks.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  for (const allowedPath of lockPlan.allowedEdits) {
    if (!isWithinAnyPath(allowedPath, lockPlan.lockedPaths, lockPlan.cwd)) {
      return {
        error: `Write job for agent "${lockPlan.agent}" has allowed edit path outside locked paths: ${allowedPath}.`,
        errorType: "lock_plan_rejected",
        lockPlan,
      };
    }
  }

  const forbiddenOverlap = overlaps(lockPlan.allowedEdits, lockPlan.forbiddenEdits);
  if (forbiddenOverlap) {
    return {
      error: `Write job for agent "${lockPlan.agent}" allows a forbidden edit path: ${forbiddenOverlap[0]} / ${forbiddenOverlap[1]}.`,
      errorType: "lock_plan_rejected",
      lockPlan,
    };
  }

  return { error: null, lockPlan };
}

async function executeOpenCodeJob(requestedJob, { toolStarted = nowMs(), jobId = null } = {}) {
  const {
    agent,
    task,
    cwd,
    allowFallbackToBuild = false,
    subagentStrategy = "proxy",
    proxyAgent = DEFAULT_SUBAGENT_PROXY_AGENT,
    dryRun = false,
    delegation,
  } = requestedJob;
  const effectiveJobId = jobId || makeQueueJobId(agent);
  const { error: lockPlanError, errorType: lockPlanErrorType, suggestedFix: lockPlanSuggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(requestedJob);

  if (lockPlanError || (hasWriteIntent(requestedJob) && lockPlan.lockType === "read")) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
              errorType: lockPlanErrorType || "lock_plan_rejected",
              reason: lockPlanError || `Write-capable agent "${agent}" requires lockedPaths so the bridge can create a temporary write lock.`,
              requestedAgent: agent,
              actualAgent: "none",
              lockMode: lockPlan?.lockMode || "unknown",
              durationMs: nowMs() - toolStarted,
              lockedPaths: lockPlan?.lockedPaths || [],
              allowedEdits: lockPlan?.allowedEdits || [],
              serialOnlyMatches,
              suggestedFix: lockPlanSuggestedFix || "Pass lockedPaths and allowedEdits to run_opencode_agent; do not pre-acquire locks manually.",
            }),
          },
        ],
      },
      result: {
        errorType: lockPlanErrorType || "lock_plan_rejected",
        changedFiles: [],
      },
      lockPlan,
    };
  }

  const resolution = await resolveAgent(agent, cwd, allowFallbackToBuild, subagentStrategy, proxyAgent);
  if (resolution.error) {
    return {
      response: {
        content: [
          {
            type: "text",
            text: [
              formatRejectedExecution({
                headline: "OpenCode agent routing failed.",
                errorType: "agent_routing_error",
                reason: resolution.error,
                requestedAgent: resolution.requestedAgent,
                actualAgent: "none",
                fallback: resolution.fallbackUsed,
                fallbackReason: resolution.fallbackReason,
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
              }),
              "",
              `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
              `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
              `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
              `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
              `Discovery exit code: ${resolution.discoveryExitCode}`,
              `Available agents parsed: ${resolution.availableAgents.join(", ") || "none parsed"}`,
            ].join("\n"),
          },
        ],
      },
      result: {
        errorType: "agent_routing_error",
        changedFiles: [],
      },
      lockPlan,
      resolution,
    };
  }

  const normalizedDelegation = {
    ...delegation,
    lockMode: lockPlan.lockMode,
    lockType: lockPlan.lockType,
    orchestratorMode: lockPlan.orchestratorMode,
    lockedPaths: lockPlan.lockedPaths,
    allowedEdits: lockPlan.allowedEdits,
    forbiddenEdits: lockPlan.forbiddenEdits,
    sharedFiles: lockPlan.sharedFiles,
    scopeContract: lockPlan.scopeContract,
    validationCommand: lockPlan.validationCommand,
  };

  let prompt = buildCompactPrompt(resolution.requestedAgent, task, normalizedDelegation);
  if (resolution.proxyUsed) {
    prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
  }

  let acquiredLock = null;
  let worktree = null;
  let worktreeDiff = null;
  let worktreeCleanup = null;
  const shouldAcquireLock = !dryRun && lockPlan.lockType !== "read";
  let executionCwd = cwd || process.cwd();

  try {
    if (shouldAcquireLock) {
      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: resolution.requestedAgent,
        task,
        cwd: cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: hardLockPathsForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: "Manual lock already exists. Do not pre-acquire locks before run_opencode_agent.",
                  errorType: "manual_lock_conflict",
                  reason: lockResult.error,
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: "Release the existing manual lock or wait for it to expire, then call run_opencode_agent with lockedPaths only.",
                }),
              },
            ],
          },
          result: {
            errorType: "manual_lock_conflict",
            changedFiles: [],
          },
          lockPlan,
          resolution,
        };
      }

      acquiredLock = lockResult.lock;
    }

    if (shouldUseWorktree(requestedJob, lockPlan)) {
      const worktreeResult = await createWorktreeForJob({
        cwd: cwd || process.cwd(),
        agent: resolution.requestedAgent,
        jobId: effectiveJobId,
      });

      if (!worktreeResult.ok) {
        return {
          response: {
            content: [
              {
                type: "text",
                text: formatRejectedExecution({
                  headline: "Worktree setup failed.",
                  errorType: worktreeResult.errorType || "worktree_create_failed",
                  reason: worktreeResult.error || "Could not create a Git worktree for this job.",
                  requestedAgent: resolution.requestedAgent,
                  actualAgent: resolution.actualAgent,
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  lockedPaths: lockPlan.lockedPaths,
                  allowedEdits: lockPlan.allowedEdits,
                  suggestedFix: "Disable CODEX_OPENCODE_WORKTREE_MODE, choose a safe worktree root, or ensure this cwd is a Git repository with git available.",
                }),
              },
            ],
          },
          result: {
            errorType: worktreeResult.errorType || "worktree_create_failed",
            changedFiles: [],
          },
          lockPlan,
          resolution,
          worktree: worktreeResult,
        };
      }

      worktree = worktreeResult;
      executionCwd = worktree.path;
    }

    const rollbackBaseline = dryRun ? null : await captureRollbackBaseline(executionCwd);
    const beforeFiles = dryRun ? new Map() : await gitChangedFileSnapshot(executionCwd);
    let result = await runOpenCodeWithPolicy(resolution.actualAgent, prompt, executionCwd, dryRun, lockPlan, lockPlan.timeoutMs);
    const afterFiles = dryRun ? new Map() : await gitChangedFileSnapshot(executionCwd);
    result.changedFiles = changedFilesBetween(beforeFiles, afterFiles);

    const validation = validateChangedFilesForPlan({ changedFiles: result.changedFiles, lockPlan, parallel: false });
    const rollbackResult = validation.disallowedFiles.length && !dryRun
      ? await rollbackUnsafeChanges({ cwd: executionCwd, baseline: rollbackBaseline, files: validation.disallowedFiles })
      : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };

    if (worktree) {
      worktreeDiff = await collectWorktreeDiff(worktree);
      worktreeCleanup = await cleanupWorktree(worktree, CONFIG.worktreeCleanup, !validation.disallowedFiles.length && !result.errorType);
      result.worktree = {
        path: worktree.path,
        branch: worktree.branch,
        cleanup: worktreeCleanup.cleanup,
        changedFiles: worktreeDiff?.changedFiles || [],
        diffStat: worktreeDiff?.diffStat || "",
      };
      if (worktreeCleanup.errorType && !result.errorType) {
        result.errorType = worktreeCleanup.errorType;
      }
    }

    await recordChangedFiles(acquiredLock?.id, cwd, result.changedFiles, validation.disallowedFiles);
    const validationErrorType = validation.disallowedFiles.length && worktree && changedFileValidationErrorType(validation) === "changed_file_validation_error"
      ? "worktree_changed_file_validation_error"
      : changedFileValidationErrorType(validation);
    const lockViolation = validation.disallowedFiles.length
      ? [
          "",
          "Write lock verification:",
          formatRejectedExecution({
            headline: "OpenCode result rejected.",
            errorType: validationErrorType,
            reason: "The OpenCode result changed files outside the granted allowedEdits or Scope Contract, touched forbidden/shared paths, or a read-only agent edited files.",
            requestedAgent: resolution.requestedAgent,
            actualAgent: resolution.actualAgent,
            lockMode: lockPlan.lockMode,
            durationMs: result.durationMs ?? nowMs() - toolStarted,
            conflictingPaths: validation.disallowedFiles,
            lockedPaths: lockPlan.lockedPaths,
            allowedEdits: lockPlan.allowedEdits,
            runId: acquiredLock?.id || "",
            rollback: rollbackResult.rollback,
            disallowedFiles: validation.disallowedFiles,
            serialOnlyMatches: validation.serialOnlyMatches,
            rollbackFiles: rollbackResult.rollbackFiles,
            unresolvedFiles: rollbackResult.unresolvedFiles,
            suggestedFix: "Inspect any unresolved files, then rerun with explicit lockedPaths and allowedEdits or handle the work serially.",
          }),
        ].join("\n")
      : ["", "Write lock verification:", "Accepted. Detected changed files stayed inside allowedEdits and did not touch forbidden/shared paths."].join("\n");
    const nativeFallbackViolation = result.openCodeFallbackDetected
      ? [
          "",
          "OpenCode native fallback verification:",
          "Rejected. The requested role may not have executed because OpenCode fell back internally.",
        ].join("\n")
      : ["", "OpenCode native fallback verification:", "Accepted. No native fallback detected."].join("\n");
    const apiErrorViolation = result.openCodeApiErrorDetected
      ? [
          "",
          "OpenCode API error verification:",
          "Rejected. OpenCode returned an API error event even though the process may have exited successfully.",
        ].join("\n")
      : ["", "OpenCode API error verification:", "Accepted. No OpenCode API error detected."].join("\n");
    const worktreeReview = worktree
      ? [
          "",
          "Worktree review:",
          formatWorktreeSummary(worktree, worktreeCleanup),
          `Worktree changed files: ${(worktreeDiff?.changedFiles || []).length ? worktreeDiff.changedFiles.join(", ") : "none detected"}`,
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : "Worktree diff stat: none",
          worktreeDiff?.patchPreview ? `Worktree patch preview:\n${worktreeDiff.patchPreview}` : "Worktree patch preview: none",
        ].join("\n")
      : ["", "Worktree review:", "Worktree: not used"].join("\n");

    return {
      response: {
        content: [
          {
            type: "text",
            text: [
              `Temporary lock acquired: ${hardLockSummary(acquiredLock)}`,
              `Temporary lock released: ${acquiredLock ? "yes" : "not needed"}`,
              formatSingleResult({ resolution, result, cwd: executionCwd, lockPlan }),
              worktreeReview,
              nativeFallbackViolation,
              apiErrorViolation,
              lockViolation,
            ].join("\n"),
          },
        ],
      },
      result,
      lockPlan,
      resolution,
      validation,
      worktree,
      worktreeCleanup,
    };
  } finally {
    if (acquiredLock) {
      await releaseHardLock(acquiredLock.id, acquiredLock.token, acquiredLock.paths, acquiredLock.cwd);
    }
  }
}

function queueRecordSnapshot(record, includeResult = true) {
  return {
    jobId: record.jobId,
    parentJobId: record.parentJobId || "",
    agent: record.agent,
    task: record.task,
    mode: record.mode,
    scopeContract: record.scopeContract || null,
    lockMode: record.lockMode,
    lockedPaths: record.lockedPaths || [],
    allowedEdits: record.allowedEdits || [],
    worktreePath: record.worktreePath || "",
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt || "",
    finishedAt: record.finishedAt || "",
    durationMs: record.durationMs || 0,
    retryCount: record.retryCount || 0,
    maxRetries: record.maxRetries || 0,
    errorType: record.errorType || "",
    errorReason: record.errorReason || "",
    changedFiles: record.changedFiles || [],
    validationResult: record.validationResult || null,
    cancellationRequested: Boolean(record.cancellationRequested),
    resultText: includeResult ? truncateText(record.resultText || "", 20000) : "",
  };
}

async function persistQueueRecord(record) {
  if (CONFIG.queueMode !== "sqlite") {
    return;
  }

  const db = await openLockDb(record.cwd);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO opencode_jobs
      (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.jobId,
      record.cwd || "",
      record.status,
      record.agent,
      record.mode,
      record.createdAt,
      record.startedAt || "",
      record.finishedAt || "",
      JSON.stringify(queueRecordSnapshot(record))
    );
  } finally {
    closeDb(db);
  }
}

function updateQueueRecord(record, patch = {}) {
  Object.assign(record, patch);
  persistQueueRecord(record).catch((error) => {
    logEvent("warn", "queue.persist_failed", {
      jobId: record.jobId,
      error: error.message || String(error),
    });
  });
  return record;
}

function queueMaxRetriesForPlan(lockPlan) {
  return lockPlan.lockType === "read" ? CONFIG.queueReadOnlyRetries : CONFIG.queueWriteRetries;
}

function queueLockPathsForRecord(record) {
  return normalizeLockPathList(record.allowedEdits?.length ? record.allowedEdits : record.lockedPaths);
}

function runningQueueRecords() {
  return [...QUEUE_JOBS.values()].filter((record) => ["running", "validating", "reviewing", "testing"].includes(record.status));
}

function findQueueWriteConflict(record) {
  if (record.mode !== "write") {
    return null;
  }

  const cwdKey = path.resolve(record.cwd || process.cwd());
  for (const running of runningQueueRecords()) {
    if (running.mode !== "write") {
      continue;
    }

    if (path.resolve(running.cwd || process.cwd()) !== cwdKey) {
      continue;
    }

    const overlap = overlaps(queueLockPathsForRecord(record), queueLockPathsForRecord(running));
    if (overlap) {
      return {
        jobId: running.jobId,
        paths: overlap,
      };
    }
  }

  return null;
}

function assessQueuePlan(lockPlans = []) {
  if (CONFIG.queueMode === "off") {
    return {
      status: "disabled",
      reason: "Queue mode is off.",
      conflictingPaths: [],
    };
  }

  for (const plan of lockPlans) {
    const candidate = {
      mode: plan.lockType === "read" ? "read" : "write",
      cwd: plan.cwd,
      lockedPaths: plan.lockedPaths,
      allowedEdits: plan.allowedEdits,
    };
    const conflict = findQueueWriteConflict(candidate);
    if (conflict) {
      return {
        status: CONFIG.queueWriteConflictPolicy === "reject" ? "conflict" : "must_wait",
        reason: `Queued/running write job ${conflict.jobId} overlaps this plan.`,
        conflictingPaths: conflict.paths,
      };
    }
  }

  return {
    status: "can_run_immediately",
    reason: "No queue write conflict detected.",
    conflictingPaths: [],
  };
}

async function enqueueQueueJob(job, parentJobId = "", { schedule = true } = {}) {
  if (CONFIG.queueMode === "off") {
    return {
      ok: false,
      errorType: "queue_disabled",
      error: "CODEX_OPENCODE_QUEUE_MODE is off.",
      suggestedFix: "Set CODEX_OPENCODE_QUEUE_MODE=memory or sqlite, or call run_opencode_agent directly.",
    };
  }

  const { error, errorType, suggestedFix, lockPlan, serialOnlyMatches = [] } = validateSingleLockPlan(job);
  if (error || (hasWriteIntent(job) && lockPlan.lockType === "read")) {
    return {
      ok: false,
      errorType: errorType || "lock_plan_rejected",
      error: error || `Write-capable agent "${job.agent}" requires lockedPaths so the bridge can create a temporary write lock.`,
      suggestedFix: suggestedFix || "Fix the Scope Contract, lockMode, lockedPaths, and allowedEdits before enqueueing.",
      serialOnlyMatches,
      lockPlan,
    };
  }

  const now = new Date().toISOString();
  const jobId = makeQueueJobId(job.agent);
  const record = {
    jobId,
    parentJobId,
    request: { ...job },
    cwd: job.cwd || process.cwd(),
    agent: job.agent,
    task: job.task,
    mode: lockPlan.lockType === "read" ? "read" : "write",
    scopeContract: lockPlan.scopeContract || null,
    lockMode: lockPlan.lockMode,
    lockedPaths: lockPlan.lockedPaths,
    allowedEdits: lockPlan.allowedEdits,
    status: "pending",
    createdAt: now,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    retryCount: 0,
    maxRetries: queueMaxRetriesForPlan(lockPlan),
    errorType: "",
    errorReason: "",
    changedFiles: [],
    validationResult: null,
    resultText: "",
    worktreePath: "",
    cancellationRequested: false,
  };

  QUEUE_JOBS.set(jobId, record);
  await persistQueueRecord(record);
  if (schedule) {
    scheduleQueue();
  }
  return { ok: true, record };
}

function shouldRetryQueueJob(record, execution) {
  const errorType = execution?.result?.errorType || "";
  if (!errorType || record.retryCount >= record.maxRetries) {
    return false;
  }

  if (record.mode === "write") {
    return false;
  }

  return ["agent_timeout", "read_only_agent_unavailable"].includes(errorType);
}

function startQueueRecord(record) {
  updateQueueRecord(record, {
    status: "running",
    startedAt: record.startedAt || new Date().toISOString(),
    errorType: "",
    errorReason: "",
  });

  record.executionPromise = (async () => {
    const started = nowMs();
    try {
      if (record.cancellationRequested) {
        updateQueueRecord(record, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: nowMs() - started,
        });
        return;
      }

      const execution = await executeOpenCodeJob(record.request, { toolStarted: started, jobId: record.jobId });
      const validationError = execution.validation?.disallowedFiles?.length
        ? changedFileValidationErrorType(execution.validation)
        : "";
      const errorType = execution.result?.errorType || validationError || "";

      if (shouldRetryQueueJob(record, execution)) {
        updateQueueRecord(record, {
          status: "pending",
          retryCount: record.retryCount + 1,
          errorType,
          errorReason: "Retrying safe read-only job after timeout.",
        });
        return;
      }

      updateQueueRecord(record, {
        status: errorType ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - started,
        errorType,
        errorReason: errorType ? summarizeStderr(execution.result?.stderr) || errorType : "",
        changedFiles: execution.result?.changedFiles || [],
        validationResult: execution.validation || null,
        resultText: execution.response?.content?.[0]?.text || "",
        worktreePath: execution.worktree?.path || "",
      });
    } catch (error) {
      updateQueueRecord(record, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - started,
        errorType: "queue_job_failed",
        errorReason: error.message || String(error),
      });
    } finally {
      delete record.executionPromise;
      scheduleQueue();
    }
  })();
}

function scheduleQueue() {
  if (CONFIG.queueMode === "off" || queueSchedulerActive) {
    return;
  }

  queueSchedulerActive = true;
  setTimeout(() => {
    try {
      const runningCount = runningQueueRecords().length;
      let capacity = Math.max(0, CONFIG.queueParallelLimit - runningCount);
      if (!capacity) {
        return;
      }

      for (const record of QUEUE_JOBS.values()) {
        if (!capacity) {
          break;
        }

        if (!["pending", "blocked", "planned"].includes(record.status)) {
          continue;
        }

        if (record.cancellationRequested) {
          updateQueueRecord(record, {
            status: "cancelled",
            finishedAt: new Date().toISOString(),
          });
          continue;
        }

        updateQueueRecord(record, { status: "planned" });
        const conflict = findQueueWriteConflict(record);
        if (conflict) {
          if (CONFIG.queueWriteConflictPolicy === "reject") {
            updateQueueRecord(record, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              errorType: "write_lock_conflict",
              errorReason: `Write lock conflict on: ${conflict.paths[0] || "unknown"}`,
            });
          } else {
            updateQueueRecord(record, {
              status: "blocked",
              errorType: "write_lock_conflict",
              errorReason: `Waiting for queued write job ${conflict.jobId} to release: ${conflict.paths.join(", ")}`,
            });
          }
          continue;
        }

        startQueueRecord(record);
        capacity -= 1;
      }
    } finally {
      queueSchedulerActive = false;
      const runnable = [...QUEUE_JOBS.values()].some((record) => ["pending", "planned"].includes(record.status));
      if (runnable && runningQueueRecords().length < CONFIG.queueParallelLimit) {
        scheduleQueue();
      }
    }
  }, 0);
}

async function readPersistedQueueRecord(jobId, cwd = "") {
  if (CONFIG.queueMode !== "sqlite") {
    return null;
  }

  const db = await openLockDb(cwd);
  try {
    const row = db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
    return row?.record_json ? JSON.parse(row.record_json) : null;
  } finally {
    closeDb(db);
  }
}

async function listPersistedQueueRecords(cwd = "", status = "") {
  if (CONFIG.queueMode !== "sqlite") {
    return [];
  }

  const db = await openLockDb(cwd);
  try {
    const rows = status
      ? db.prepare("SELECT record_json FROM opencode_jobs WHERE status = ? ORDER BY created_at DESC").all(status)
      : db.prepare("SELECT record_json FROM opencode_jobs ORDER BY created_at DESC").all();
    return rows.map((row) => JSON.parse(row.record_json));
  } finally {
    closeDb(db);
  }
}

function verifyParallelLockResults(jobResults) {
  const violations = [];
  const changedByFile = new Map();

  for (const jobResult of jobResults) {
    const { index, lockPlan, result } = jobResult;
    const label = `JOB ${index + 1} (${lockPlan.agent})`;
    const changedFiles = result?.changedFiles || [];

    if (result?.timedOut && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`Agent timeout: ${lockPlan.agent}`);
    } else if (result && result.exitCode !== 0 && !(lockPlan.lockType === "read" && result.readOnlyUnavailable)) {
      violations.push(`${label} exited with ${result.exitCode}; do not accept this parallel result without recovery.`);
    }

    if (result?.openCodeFallbackDetected) {
      violations.push(`${label} triggered OpenCode native subagent fallback; do not accept this result because the requested role may not have executed.`);
    }

    if (result?.openCodeApiErrorDetected) {
      violations.push(`${label} returned an OpenCode API error event; do not accept this result without recovery.`);
    }

    if (lockPlan.lockType === "read" && changedFiles.length) {
      violations.push(`${label} was read-only but changed files: ${changedFiles.join(", ")}.`);
    }

    if (lockPlan.lockType === "write") {
      const outsideLock = unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd);
      if (outsideLock.length) {
        violations.push(`${label} changed files outside its allowed edit paths: ${outsideLock.join(", ")}.`);
      }
    }

    const forbiddenChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd));
    if (forbiddenChanged.length) {
      violations.push(`${label} changed forbidden files: ${forbiddenChanged.join(", ")}.`);
    }

    const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);
    if (scopeViolations.outsideWriteScope.length) {
      violations.push(`${label} changed files outside its Scope Contract write paths: ${scopeViolations.outsideWriteScope.join(", ")}.`);
    }
    if (scopeViolations.forbiddenFiles.length) {
      violations.push(`${label} changed Scope Contract forbidden files: ${scopeViolations.forbiddenFiles.join(", ")}.`);
    }
    if (scopeViolations.readOnlyChangedFiles.length) {
      violations.push(`${label} violated a read-only Scope Contract by changing files: ${scopeViolations.readOnlyChangedFiles.join(", ")}.`);
    }

    const sharedChanged = changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd));
    if (sharedChanged.length) {
      violations.push(`${label} changed shared/frozen files: ${sharedChanged.join(", ")}.`);
    }

    const restrictedChanged = findSerialOnlyMatches(changedFiles);
    if (restrictedChanged.length) {
      violations.push(`${label} changed serial-only paths: ${restrictedChanged.join(", ")}.`);
    }

    for (const file of changedFiles) {
      const normalized = normalizePathForCompare(file);
      const existing = changedByFile.get(normalized) || [];
      existing.push(label);
      changedByFile.set(normalized, existing);
    }
  }

  for (const [file, labels] of changedByFile.entries()) {
    if (labels.length > 1) {
      violations.push(`Multiple parallel jobs changed the same file "${file}": ${labels.join(", ")}.`);
    }
  }

  return violations;
}

server.tool(
  "run_opencode_parallel",
  "Run multiple OpenCode agents in parallel. Use only for safe independent tasks.",
  {
    jobs: z.array(
      z.object({
        agent: z.string(),
        task: z.string(),
        cwd: z.string().optional(),
        allowFallbackToBuild: z.boolean().optional(),
        subagentStrategy: z.enum(["proxy", "direct", "reject"]).optional(),
        proxyAgent: z.string().optional(),
        orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional().describe("OpenCode orchestrator large task mode."),
        role: z.string().optional().describe("Optional Scope Contract role label."),
        mode: z.enum(["read", "write", "read-only", "readonly"]).optional().describe("Optional Scope Contract read/write mode."),
        scope: scopePathSetSchema.optional().describe("Optional Scope Contract paths: read, write, and forbidden."),
        actions: z.array(z.string()).optional().describe("Optional Scope Contract allowed actions."),
        validation: scopeValidationSchema.optional().describe("Optional Scope Contract validation rules."),
        timeoutPolicy: scopeTimeoutPolicySchema.optional().describe("Optional Scope Contract timeout policy."),
        scopeContract: scopeContractSchema.optional().describe("Optional full Scope Contract."),
        dryRun: z.boolean().optional(),
        write: z.boolean().optional().describe("Whether this job may edit files. Required for explicit write planning."),
        lockMode: z.string().optional().describe("off for read-only, simple for single write, strict for parallel write."),
        lockType: z.string().optional().describe("read, write, or serial_integration. serial_integration is rejected in parallel."),
        timeoutMs: z.number().int().positive().optional().describe("Optional per-job timeout in milliseconds."),
        lockedPaths: z.array(z.string()).optional().describe("Paths granted by the orchestrator lock owner. Use concrete file or directory paths."),
        ownedPaths: z.array(z.string()).optional(),
        allowedEdits: z.array(z.string()).optional(),
        forbiddenEdits: z.array(z.string()).optional(),
        sharedFiles: z.array(z.string()).optional(),
        validationCommand: z.string().optional(),
        delegation: z
          .object({
            scope: z.union([z.array(z.string()), scopePathSetSchema]).optional(),
            role: z.string().optional(),
            mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
            actions: z.array(z.string()).optional(),
            validation: scopeValidationSchema.optional(),
            timeoutPolicy: scopeTimeoutPolicySchema.optional(),
            scopeContract: scopeContractSchema.optional(),
            lockMode: z.string().optional(),
            lockType: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
            orchestratorMode: z.enum(["planning-only", "bounded-writer"]).optional(),
            lockedPaths: z.array(z.string()).optional(),
            allowedEdits: z.array(z.string()).optional(),
            forbiddenEdits: z.array(z.string()).optional(),
            sharedFiles: z.array(z.string()).optional(),
            permissions: z.string().optional(),
            validationCommand: z.string().optional(),
            returnFormat: z.string().optional(),
          })
          .optional(),
      })
    ).min(1),
  },
  async ({ jobs }) => {
    const toolStarted = nowMs();
    const { error: writePlanError, errorType: writePlanErrorType, suggestedFix: writePlanSuggestedFix, lockPlans, conflictingPaths = [], serialOnlyMatches = [] } = validateParallelWritePlan(jobs);
    if (writePlanError) {
      const requestedAgents = lockPlans?.map((plan) => plan.agent).filter(Boolean).join(", ") || "multiple";
      const lockMode = lockPlans?.map((plan) => plan.lockMode).filter(Boolean).join(", ") || "unknown";
      return {
        content: [
          {
            type: "text",
            text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: writePlanErrorType || "parallel_plan_rejected",
                reason: writePlanError,
                requestedAgent: requestedAgents,
                actualAgent: "none",
                lockMode,
                durationMs: nowMs() - toolStarted,
                conflictingPaths,
                serialOnlyMatches,
                suggestedFix: writePlanSuggestedFix || "Read-only jobs use lockMode off. Write jobs need non-overlapping lockedPaths and explicit allowedEdits.",
              }),
          },
        ],
      };
    }

    const acquiredLocks = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      const shouldAcquireLock = !job.dryRun && lockPlan.lockType !== "read";

      if (!shouldAcquireLock) {
        acquiredLocks[index] = null;
        continue;
      }

      const lockResult = await acquireHardLock({
        owner: "codex",
        agent: lockPlan.agent,
        task: lockPlan.task,
        cwd: job.cwd || process.cwd(),
        lockType: lockPlan.lockType,
        paths: lockPlan.lockType === "read" ? lockPlan.lockedPaths : hardLockPathsForPlan(lockPlan),
      });

      if (!lockResult.ok) {
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        const conflictingPaths = conflictPathsFromConflict(lockResult.conflict);
        return {
          content: [
            {
              type: "text",
              text: [
                formatRejectedExecution({
                  headline: "Parallel OpenCode execution rejected.",
                  errorType: "write_lock_conflict",
                  reason: lockResult.error,
                  requestedAgent: lockPlan.agent,
                  actualAgent: "none",
                  lockMode: lockPlan.lockMode,
                  durationMs: nowMs() - toolStarted,
                  conflictingPaths,
                  suggestedFix: "Release the existing lock or wait for it to expire, then retry with non-overlapping lockedPaths.",
                }),
                "",
                "No OpenCode jobs were started after this write-lock rejection.",
              ].join("\n"),
            },
          ],
        };
      }

      acquiredLocks[index] = lockResult.lock;
    }

    const parallelWorktrees = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const lockPlan = lockPlans[index];
      if (!shouldUseWorktree(job, lockPlan)) {
        parallelWorktrees[index] = null;
        continue;
      }

      const worktreeResult = await createWorktreeForJob({
        cwd: job.cwd || process.cwd(),
        agent: lockPlan.agent,
        jobId: makeQueueJobId(lockPlan.agent),
      });

      if (!worktreeResult.ok) {
        await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
        await Promise.all(parallelWorktrees.filter(Boolean).map((worktree) => cleanupWorktree(worktree, "always", true)));
        return {
          content: [
            {
              type: "text",
              text: formatRejectedExecution({
                headline: "Parallel OpenCode execution rejected.",
                errorType: worktreeResult.errorType || "worktree_create_failed",
                reason: worktreeResult.error || "Could not create a Git worktree for this parallel job.",
                requestedAgent: lockPlan.agent,
                actualAgent: "none",
                lockMode: lockPlan.lockMode,
                durationMs: nowMs() - toolStarted,
                lockedPaths: lockPlan.lockedPaths,
                allowedEdits: lockPlan.allowedEdits,
                suggestedFix: "Disable CODEX_OPENCODE_WORKTREE_MODE, choose a safe worktree root, or ensure this cwd is a Git repository with git available.",
              }),
            },
          ],
        };
      }

      parallelWorktrees[index] = worktreeResult;
    }

    const executionCwdForIndex = (index) => parallelWorktrees[index]?.path || jobs[index].cwd || process.cwd();
    const cwdKeys = [...new Set(jobs.map((_, index) => path.resolve(executionCwdForIndex(index))))];
    const parallelBaselines = new Map();
    const parallelBefore = new Map();
    for (const cwdKey of cwdKeys) {
      parallelBaselines.set(cwdKey, await captureRollbackBaseline(cwdKey));
      parallelBefore.set(cwdKey, await gitChangedFileSnapshot(cwdKey));
    }

    let results;
    const parallelRollbackReports = [];
    try {
      results = await Promise.all(
        jobs.map(async (job, index) => {
        const lockPlan = lockPlans[index];
        const resolution = await resolveAgent(
          job.agent,
          job.cwd,
          job.allowFallbackToBuild || false,
          job.subagentStrategy || "proxy",
          job.proxyAgent || DEFAULT_SUBAGENT_PROXY_AGENT
        );
        if (resolution.error) {
          return {
            index,
            lockPlan,
            result: { changedFiles: [], exitCode: "not run", errorType: "agent_routing_error", openCodeFallbackDetected: false },
            text: [
            `JOB ${index + 1}`,
            formatRejectedExecution({
              headline: "OpenCode agent routing failed.",
              errorType: "agent_routing_error",
              reason: resolution.error,
              requestedAgent: resolution.requestedAgent,
              actualAgent: "none",
              fallback: resolution.fallbackUsed,
              fallbackReason: resolution.fallbackReason,
              lockMode: lockPlan.lockMode,
              durationMs: nowMs() - toolStarted,
              suggestedFix: "Install or enable the requested OpenCode agent, or explicitly set allowFallbackToBuild only when build is acceptable.",
            }),
            `Requested agent mode: ${resolution.requestedAgentMode || "unknown"}`,
            `Fallback used: ${resolution.fallbackUsed ? "yes" : "no"}`,
            `Subagent proxy used: ${resolution.proxyUsed ? "yes" : "no"}`,
            `Subagent strategy: ${resolution.subagentStrategy || "direct"}`,
            resolution.error,
            ].join("\n"),
          };
        }

        const executionCwd = executionCwdForIndex(index);
        const beforeFiles = job.dryRun ? new Map() : await gitChangedFileSnapshot(executionCwd);
        const delegation = {
          scope: job.delegation?.scope,
          lockMode: lockPlan.lockMode,
          lockType: lockPlan.lockType,
          orchestratorMode: lockPlan.orchestratorMode,
          lockedPaths: lockPlan.lockedPaths,
          allowedEdits: lockPlan.allowedEdits,
          forbiddenEdits: lockPlan.forbiddenEdits,
          sharedFiles: lockPlan.sharedFiles,
          scopeContract: lockPlan.scopeContract,
          permissions: job.delegation?.permissions || (lockPlan.lockType === "write" ? "write allowed only inside Lock granted; bash ask" : "read-only; no edits; bash ask"),
          validationCommand: lockPlan.validationCommand,
          returnFormat: job.delegation?.returnFormat,
        };

        let prompt = buildCompactPrompt(resolution.requestedAgent, job.task, delegation);
        if (resolution.proxyUsed) {
          prompt = buildSubagentProxyPrompt(resolution.requestedAgent, await readAgentDefinition(resolution.requestedAgent), prompt);
        }
        const result = await runOpenCodeWithPolicy(resolution.actualAgent, prompt, executionCwd, job.dryRun || false, lockPlan, lockPlan.timeoutMs);
        const afterFiles = job.dryRun ? new Map() : await gitChangedFileSnapshot(executionCwd);
        result.changedFiles = changedFilesBetween(beforeFiles, afterFiles);
        const unsafeFiles = lockPlan.lockType === "write" ? unsafeChangedFiles(result.changedFiles, lockPlan.allowedEdits, job.cwd) : result.changedFiles;
        const worktree = parallelWorktrees[index];
        const worktreeDiff = worktree ? await collectWorktreeDiff(worktree) : null;
        if (worktree) {
          result.worktree = {
            path: worktree.path,
            branch: worktree.branch,
            cleanup: "deferred",
            changedFiles: worktreeDiff?.changedFiles || [],
            diffStat: worktreeDiff?.diffStat || "",
          };
        }
        return {
          index,
          lockPlan,
          result,
          text: [
          `JOB ${index + 1}`,
          `Temporary lock acquired: ${hardLockSummary(acquiredLocks[index])}`,
          formatSingleResult({
            resolution,
            result,
            cwd: executionCwd,
            lockPlan,
          }),
          formatWorktreeSummary(worktree, null),
          worktreeDiff?.diffStat ? `Worktree diff stat:\n${worktreeDiff.diffStat}` : null,
          `Validation command: ${lockPlan.validationCommand || "not specified"}`,
          `Unsafe changed files: ${unsafeFiles.length ? unsafeFiles.join(", ") : "none detected"}`,
          ].filter(Boolean).join("\n"),
        };
        })
      );
      for (const cwdKey of cwdKeys) {
        const after = await gitChangedFileSnapshot(cwdKey);
        const changedFiles = changedFilesBetween(parallelBefore.get(cwdKey) || new Map(), after);
        const plansForCwd = lockPlans.filter((_, index) => path.resolve(executionCwdForIndex(index)) === cwdKey);
        const writePlansForCwd = plansForCwd.filter((plan) => plan.lockType === "write");
        const allowedEditsForCwd = writePlansForCwd.flatMap((plan) => plan.allowedEdits);
        const forbiddenForCwd = plansForCwd.flatMap((plan) => plan.forbiddenEdits.concat(plan.sharedFiles));
        const serialOnlyMatches = findSerialOnlyMatches(changedFiles);
        const disallowedFiles = normalizeLockPathList([
          ...(writePlansForCwd.length ? unsafeChangedFiles(changedFiles, allowedEditsForCwd, cwdKey) : changedFiles),
          ...changedFiles.filter((file) => isWithinAnyPath(file, forbiddenForCwd, cwdKey)),
          ...changedFiles.filter((file) => findSerialOnlyMatches([file]).length),
        ]);
        const rollbackResult = disallowedFiles.length
          ? await rollbackUnsafeChanges({ cwd: cwdKey, baseline: parallelBaselines.get(cwdKey), files: disallowedFiles })
          : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };
        parallelRollbackReports.push({
          cwd: cwdKey,
          changedFiles,
          disallowedFiles,
          serialOnlyMatches,
          ...rollbackResult,
        });
      }
    } finally {
      await Promise.all(acquiredLocks.filter(Boolean).map((lock) => releaseHardLock(lock.id, lock.token, lock.paths, lock.cwd)));
    }

    const lockViolations = verifyParallelLockResults(results);
    const parallelSuccess = !lockViolations.length
      && !parallelRollbackReports.some((report) => report.disallowedFiles.length)
      && !results.some((jobResult) => jobResult.result?.errorType);
    const parallelWorktreeCleanupReports = await Promise.all(
      parallelWorktrees
        .map((worktree, index) => ({ worktree, index }))
        .filter(({ worktree }) => Boolean(worktree))
        .map(async ({ worktree, index }) => ({
          index,
          path: worktree.path,
          branch: worktree.branch,
          ...(await cleanupWorktree(worktree, CONFIG.worktreeCleanup, parallelSuccess)),
        }))
    );
    const verification = [
      "Parallel lock verification:",
      lockViolations.length
        ? "Rejected. Do not accept these parallel results; move to serial integration/recovery."
        : "Accepted. All detected changed files stayed inside assigned locks.",
      lockViolations.length ? lockViolations.map((violation) => `- ${violation}`).join("\n") : "- No lock violations detected.",
    ].join("\n");
    const rollbackVerification = [
      "Parallel rollback verification:",
      parallelRollbackReports.some((report) => report.disallowedFiles.length)
        ? "Rejected. Disallowed changed files were detected and rollback was attempted."
        : "Accepted. No disallowed changed files detected at group scope.",
      ...parallelRollbackReports.map((report) =>
        [
          `Workspace: ${report.cwd}`,
          `Changed files: ${report.changedFiles.length ? report.changedFiles.join(", ") : "none detected"}`,
          `Disallowed files: ${report.disallowedFiles.length ? report.disallowedFiles.join(", ") : "none detected"}`,
          `Serial-only matches: ${report.serialOnlyMatches.length ? report.serialOnlyMatches.join(", ") : "none detected"}`,
          `Rollback: ${report.rollback}`,
          `Rollback files: ${report.rollbackFiles.length ? report.rollbackFiles.join(", ") : "none"}`,
          `Unresolved files: ${report.unresolvedFiles.length ? report.unresolvedFiles.join(", ") : "none"}`,
        ].join("\n")
      ),
    ].join("\n");
    const worktreeCleanupVerification = [
      "Parallel worktree cleanup:",
      parallelWorktreeCleanupReports.length ? "Completed according to worktree cleanup policy." : "No worktrees used.",
      ...parallelWorktreeCleanupReports.map((report) =>
        [
          `JOB ${report.index + 1}`,
          `Path: ${report.path}`,
          `Branch: ${report.branch}`,
          `Cleanup: ${report.cleanup}`,
          report.reason ? `Reason: ${report.reason}` : null,
          report.error ? `Error: ${report.error}` : null,
        ].filter(Boolean).join("\n")
      ),
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: [verification, rollbackVerification, worktreeCleanupVerification, ...results.map((result) => result.text)].join("\n\n====================\n\n"),
        },
      ],
    };
  }
);

async function runSelfTests() {
  assert.equal(detectsOpenCodeApiError('{"type":"error","message":"No payment method"}\n'), true);
  assert.equal(detectsOpenCodeApiError('{"type":"text","message":"ok"}\n'), false);
  assert.equal(detectsOpenCodeApiError("APIError: request failed\n"), true);

  assert.equal(normalizeLockPath("apps/web/**"), "apps/web");
  assert.equal(normalizeLockPath("packages/shared/**"), "packages/shared");
  assert.equal(normalizeLockPath("apps/api/**"), "apps/api");
  assert.equal(normalizeLockPath("apps/api/app/**"), "apps/api/app");
  assert.equal(normalizeLockPath("apps\\api\\app\\**\\"), "apps/api/app");
  assert.equal(normalizeLockPath("apps/web///"), "apps/web");
  assert.equal(normalizeLockPath("./apps/web/*"), "apps/web");
  assert.equal(normalizeLockPath("README.md"), "README.md");
  assert.match(unsafePathReason(["../secrets"]), /parent traversal/);
  assert.match(unsafePathReason(["~/secret"]), /home-directory/);
  assert.match(unsafePathReason(["."]), /filesystem root/);
  assert.equal(defaultBuilderTimeoutMs, 1000 * 60 * 15);
  assert.equal(defaultOrchestratorTimeoutMs, 1000 * 60 * 20);
  assert.equal(timeoutForAgent("orchestrator", { lockType: "write" }), defaultOrchestratorTimeoutMs);

  const formattedRejection = formatRejectedExecution({
    errorType: "test_error",
    reason: "Testing structured failure output.",
    requestedAgent: "builder",
    actualAgent: "none",
    lockMode: "simple",
    durationMs: 7,
  });
  assert.match(formattedRejection, /errorType: test_error/);
  assert.match(formattedRejection, /requestedAgent: builder/);
  assert.match(formattedRejection, /actualAgent: none/);
  assert.match(formattedRejection, /durationMs: 7/);

  const wildcardSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit only the web app.",
    write: true,
    lockedPaths: ["apps/web/**"],
    allowedEdits: ["apps/web/**"],
  });
  assert.equal(wildcardSingle.error, null);
  assert.deepEqual(wildcardSingle.lockPlan.lockedPaths, ["apps/web"]);
  assert.deepEqual(wildcardSingle.lockPlan.allowedEdits, ["apps/web"]);
  assert.equal(wildcardSingle.lockPlan.lockMode, "simple");

  const orchestratorWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Coordinate and edit files.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
  });
  assert.equal(orchestratorWrite.error, null);
  assert.equal(orchestratorWrite.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorPromptWrite = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Please spawn builder and modify code files.",
  });
  assert.equal(orchestratorPromptWrite.errorType, "orchestrator_internal_writer_forbidden");

  const orchestratorPlanningOnly = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Plan the complete billing service architecture and return affected files and test plan.",
    orchestratorMode: "planning-only",
  });
  assert.equal(orchestratorPlanningOnly.error, null);
  assert.equal(orchestratorPlanningOnly.lockPlan.lockType, "read");
  assert.equal(orchestratorPlanningOnly.lockPlan.orchestratorMode, "planning-only");

  const orchestratorLargeAutoPlanning = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build a complete billing service.",
  });
  assert.equal(orchestratorLargeAutoPlanning.error, null);
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.lockType, "read");
  assert.equal(orchestratorLargeAutoPlanning.lockPlan.orchestratorMode, "planning-only");

  const orchestratorBoundedWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build the isolated billing service only inside apps/billing.",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
  });
  assert.equal(orchestratorBoundedWriter.error, null);
  assert.equal(orchestratorBoundedWriter.lockPlan.lockType, "write");
  assert.equal(orchestratorBoundedWriter.lockPlan.lockMode, "simple");
  assert.equal(orchestratorBoundedWriter.lockPlan.orchestratorMode, "bounded-writer");

  const orchestratorBoundedMissingScope = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing.",
    write: true,
    lockedPaths: ["apps/billing/**"],
  });
  assert.equal(orchestratorBoundedMissingScope.errorType, "orchestrator_bounded_writer_missing_scope");

  const orchestratorBoundedInternalWriter = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and run builder internally for the database layer.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["apps/billing/**"],
    allowedEdits: ["apps/billing/**"],
  });
  assert.equal(orchestratorBoundedInternalWriter.errorType, "orchestrator_internal_writer_forbidden");

  const orchestratorBoundedGlobal = validateSingleLockPlan({
    agent: "orchestrator",
    task: "Build billing and update package metadata.",
    orchestratorMode: "bounded-writer",
    write: true,
    lockMode: "simple",
    lockedPaths: ["package.json"],
    allowedEdits: ["package.json"],
  });
  assert.equal(orchestratorBoundedGlobal.errorType, "orchestrator_global_file_requires_planning_only");

  const orchestratorParallelWriter = validateParallelWritePlan([
    {
      agent: "orchestrator",
      task: "Build billing only.",
      orchestratorMode: "bounded-writer",
      write: true,
      lockMode: "simple",
      lockedPaths: ["apps/billing/**"],
      allowedEdits: ["apps/billing/**"],
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
    },
  ]);
  assert.equal(orchestratorParallelWriter.errorType, "orchestrator_internal_writer_forbidden");

  const missingLockedPaths = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    allowedEdits: ["apps/web"],
  });
  assert.equal(missingLockedPaths.errorType, "missing_locked_paths");

  const missingAllowedEdits = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockedPaths: ["apps/web"],
  });
  assert.equal(missingAllowedEdits.errorType, "missing_allowed_edits");

  const invalidWriteLockMode = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web.",
    write: true,
    lockMode: "off",
    lockedPaths: ["apps/web"],
    allowedEdits: ["apps/web"],
  });
  assert.equal(invalidWriteLockMode.errorType, "invalid_write_lock_mode");

  const singlePreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Preflight one writer.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    },
  ]);
  assert.equal(singlePreflight.error, null);
  assert.equal(singlePreflight.executionMode, "single");
  assert.equal(singlePreflight.lockPlans[0].lockMode, "simple");
  assert.deepEqual(singlePreflight.lockPlans[0].lockedPaths, ["apps/web"]);

  const unsafeSingle = validateSingleLockPlan({
    agent: "builder",
    task: "Do unsafe edit.",
    write: true,
    lockedPaths: ["../outside"],
    allowedEdits: ["../outside"],
  });
  assert.match(unsafeSingle.error, /unsafe path input/);

  const readOnlySingle = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review without editing.",
  });
  assert.equal(readOnlySingle.error, null);
  assert.equal(readOnlySingle.lockPlan.lockType, "read");
  assert.equal(readOnlySingle.lockPlan.lockMode, "off");

  const validReadOnlyScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review web and UI only.",
    scope: {
      read: ["apps\\web\\**", "packages/ui/**"],
      forbidden: [".env", "apps/api/**"],
    },
    actions: ["read_files"],
  });
  assert.equal(validReadOnlyScope.error, null);
  assert.equal(validReadOnlyScope.lockPlan.scopeContract.mode, "read");
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.read, ["apps/web", "packages/ui"]);
  assert.deepEqual(validReadOnlyScope.lockPlan.scopeContract.scope.forbidden, [".env", "apps/api"]);

  const validWriteScope = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web only.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      read: ["apps/web/**", "packages/ui/**"],
      write: ["apps/web/**"],
      forbidden: [".env", ".env.*", "apps/api/**", "package-lock.json"],
    },
    actions: ["read_files", "edit_files", "run_tests"],
    validation: {
      changedFilesMustBeWithinWriteScope: true,
      forbiddenFilesMustNotChange: true,
      readOnlyMustNotChangeFiles: true,
    },
  });
  assert.equal(validWriteScope.error, null);
  assert.deepEqual(validWriteScope.lockPlan.allowedEdits, ["apps/web"]);
  assert.deepEqual(validWriteScope.lockPlan.scopeContract.scope.write, ["apps/web"]);

  const forbiddenOverridesWrite = validateSingleLockPlan({
    agent: "builder",
    task: "Edit web but forbid secrets.",
    write: true,
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
      forbidden: ["apps/web/.env"],
    },
  });
  assert.equal(forbiddenOverridesWrite.errorType, "scope_write_forbidden");

  const readOnlyAgentWithWriteScope = validateSingleLockPlan({
    agent: "reviewer",
    task: "Review but has write scope.",
    lockedPaths: ["apps/web/**"],
    scope: {
      write: ["apps/web/**"],
    },
  });
  assert.equal(readOnlyAgentWithWriteScope.errorType, "scope_readonly_write_scope");

  const unsafeScopePath = validateSingleLockPlan({
    agent: "builder",
    task: "Unsafe scope.",
    write: true,
    lockedPaths: ["apps/web"],
    scope: {
      write: ["..\\outside"],
    },
  });
  assert.equal(unsafeScopePath.errorType, "scope_path_unsafe");

  const nonOverlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    },
    {
      agent: "builder",
      task: "Edit api.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
    },
  ]);
  assert.equal(nonOverlappingParallel.error, null);
  assert.deepEqual(nonOverlappingParallel.lockPlans[0].allowedEdits, ["apps/web"]);
  assert.equal(nonOverlappingParallel.lockPlans[0].lockMode, "strict");

  const parallelPreflight = validateDelegationPlanInputs([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api/**"],
      allowedEdits: ["apps/api/**"],
    },
  ]);
  assert.equal(parallelPreflight.error, null);
  assert.equal(parallelPreflight.executionMode, "parallel");
  assert.deepEqual(parallelPreflight.lockPlans.map((plan) => plan.lockMode), ["strict", "strict"]);

  const tooManyParallelJobs = validateParallelWritePlan(
    Array.from({ length: CONFIG.parallelLimit + 1 }, (_, index) => ({
      agent: "reviewer",
      task: `Read-only review ${index}.`,
    }))
  );
  assert.match(tooManyParallelJobs.error, /CODEX_OPENCODE_PARALLEL_LIMIT/);

  const overlappingParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    },
    {
      agent: "builder",
      task: "Edit web components.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
    },
  ]);
  assert.match(overlappingParallel.error, /Parallel write jobs overlap/);

  const overlappingParallelScopes = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      scope: { write: ["apps/web/**"] },
    },
    {
      agent: "debugger",
      task: "Edit web src.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/src/**"],
      scope: { write: ["apps/web/src/**"] },
    },
  ]);
  assert.match(overlappingParallelScopes.error, /Parallel write jobs overlap/);

  const serialOnlyParallel = validateParallelWritePlan([
    {
      agent: "builder",
      task: "Edit package metadata.",
      write: true,
      lockedPaths: ["package.json"],
      allowedEdits: ["package.json"],
    },
    {
      agent: "debugger",
      task: "Edit api.",
      write: true,
      lockedPaths: ["apps/api"],
      allowedEdits: ["apps/api"],
    },
  ]);
  assert.equal(serialOnlyParallel.errorType, "serial_only_path_in_parallel");

  const serialOnlySingle = validateSingleLockPlan({
    agent: "builder",
    task: "Edit README serially.",
    write: true,
    lockedPaths: ["README.md"],
    allowedEdits: ["README.md"],
  });
  assert.equal(serialOnlySingle.error, null);

  const readWithScopeParallel = validateParallelWritePlan([
    {
      agent: "reviewer",
      task: "Review web while builder edits web.",
      lockedPaths: ["apps/web/**"],
    },
    {
      agent: "builder",
      task: "Edit web.",
      write: true,
      lockType: "write",
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    },
  ]);
  assert.equal(readWithScopeParallel.error, null);

  const readOnlyTimeoutViolations = verifyParallelLockResults([
    {
      index: 0,
      lockPlan: {
        agent: "reviewer",
        lockType: "read",
        lockMode: "off",
        cwd: "",
        allowedEdits: [],
        forbiddenEdits: [],
        sharedFiles: [],
      },
      result: {
        exitCode: 124,
        readOnlyUnavailable: true,
        timedOut: true,
        changedFiles: [],
        openCodeFallbackDetected: false,
        openCodeApiErrorDetected: false,
      },
    },
  ]);
  assert.deepEqual(readOnlyTimeoutViolations, []);

  if (CONFIG.queueMode !== "off") {
    QUEUE_JOBS.clear();
    const queuedReadOnly = await enqueueQueueJob({
      agent: "reviewer",
      task: "Review only.",
      dryRun: true,
    }, "", { schedule: false });
    assert.equal(queuedReadOnly.ok, true);
    assert.equal(queuedReadOnly.record.mode, "read");
    assert.equal(queuedReadOnly.record.maxRetries, CONFIG.queueReadOnlyRetries);

    const queuedWrite = await enqueueQueueJob({
      agent: "builder",
      task: "Edit web.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/**"],
      allowedEdits: ["apps/web/**"],
    }, "", { schedule: false });
    assert.equal(queuedWrite.ok, true);
    assert.equal(queuedWrite.record.mode, "write");
    assert.deepEqual(queuedWrite.record.lockedPaths, ["apps/web"]);
    assert.deepEqual(queuedWrite.record.allowedEdits, ["apps/web"]);

    updateQueueRecord(queuedWrite.record, { status: "running" });
    const queuedBlocked = await enqueueQueueJob({
      agent: "debugger",
      task: "Edit web src.",
      dryRun: true,
      write: true,
      lockedPaths: ["apps/web/src/**"],
      allowedEdits: ["apps/web/src/**"],
    }, "", { schedule: false });
    assert.equal(queuedBlocked.ok, true);
    const queueConflict = findQueueWriteConflict(queuedBlocked.record);
    assert.equal(queueConflict.jobId, queuedWrite.record.jobId);
    assert.deepEqual(queueConflict.paths, ["apps/web/src", "apps/web"]);
    const queueAssessment = assessQueuePlan([{
      lockType: "write",
      cwd: queuedBlocked.record.cwd,
      lockedPaths: queuedBlocked.record.lockedPaths,
      allowedEdits: queuedBlocked.record.allowedEdits,
    }]);
    assert.match(queueAssessment.status, /must_wait|conflict/);
    assert.equal(shouldRetryQueueJob(queuedReadOnly.record, { result: { errorType: "read_only_agent_unavailable" } }), true);
    assert.equal(shouldRetryQueueJob(queuedWrite.record, { result: { errorType: "agent_timeout" } }), false);
    assert.equal(queueRecordSnapshot(queuedReadOnly.record).status, "pending");
    updateQueueRecord(queuedBlocked.record, { status: "cancelled", finishedAt: new Date().toISOString() });
    assert.equal(queueRecordSnapshot(queuedBlocked.record).status, "cancelled");
    QUEUE_JOBS.clear();
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-opencode-mcp-"));
  try {
    const init = await runCommand("git", ["init"], tempDir, 1000 * 15);
    assert.equal(init.exitCode, 0);
    assert.match(unsafePathReason(["C:/Windows"], tempDir), /outside the allowed root|filesystem root/);

    await writeFile(path.join(tempDir, "already-untracked.txt"), "before\n", "utf8");
    const before = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "already-untracked.txt"), "after\n", "utf8");
    const after = await gitChangedFileSnapshot(tempDir);
    assert.deepEqual(changedFilesBetween(before, after), ["already-untracked.txt"]);

    const lockA = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockA.ok, true);
    assert.equal((await releaseHardLock(lockA.lock.id, "wrong-token", lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).released, true);

    const lockB = await acquireHardLock({
      owner: "codex",
      agent: "builder",
      cwd: tempDir,
      lockType: "write",
      paths: ["apps/web"],
    });
    assert.equal(lockB.ok, true);
    assert.equal((await releaseHardLock(lockA.lock.id, lockA.lock.token, lockA.lock.paths, tempDir)).ok, false);
    assert.equal((await listLocks(tempDir)).length, 1);
    const db = await openLockDb(tempDir);
    try {
      db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ?").run(Date.now() - 1, lockB.lock.id);
    } finally {
      closeDb(db);
    }
    await cleanupExpiredLocks(tempDir);
    assert.equal((await listLocks(tempDir)).length, 0);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "allowed\n", "utf8");
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "clean\n", "utf8");
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "secret\n", "utf8");
    await runCommand("git", ["add", "."], tempDir, 1000 * 15);
    const commit = await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], tempDir, 1000 * 15);
    assert.equal(commit.exitCode, 0);

    const worktree = await createWorktreeForJob({
      cwd: tempDir,
      agent: "builder",
      jobId: "self-test",
    });
    assert.equal(worktree.ok, true);
    const worktreePreserve = await cleanupWorktree(worktree, "never", false);
    assert.equal(worktreePreserve.cleanup, "skipped");
    await writeFile(path.join(worktree.path, "src", "allowed.txt"), "worktree allowed\n", "utf8");
    let worktreeChangedFiles = await gitChangedFiles(worktree.path);
    const worktreePlan = validateSingleLockPlan({
      agent: "builder",
      task: "Validate worktree allowed file.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    worktreePlan.cwd = tempDir;
    let worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.deepEqual(worktreeValidation.disallowedFiles, []);
    await writeFile(path.join(worktree.path, "src", "forbidden.txt"), "worktree forbidden\n", "utf8");
    worktreeChangedFiles = await gitChangedFiles(worktree.path);
    worktreeValidation = validateChangedFilesForPlan({ changedFiles: worktreeChangedFiles, lockPlan: worktreePlan });
    assert.equal(changedFileValidationErrorType(worktreeValidation), "scope_forbidden_file_violation");
    assert.ok(worktreeValidation.disallowedFiles.includes("src/forbidden.txt"));
    const worktreeDiff = await collectWorktreeDiff(worktree);
    assert.ok(worktreeDiff.changedFiles.includes("src/allowed.txt"));
    const worktreeCleanup = await cleanupWorktree(worktree, "always", true);
    assert.notEqual(worktreeCleanup.cleanup, "failed");

    const writerPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit allowed only.",
      write: true,
      lockedPaths: ["src"],
      allowedEdits: ["src/allowed.txt"],
    }).lockPlan;
    writerPlan.cwd = tempDir;

    let rollbackBaseline = await captureRollbackBaseline(tempDir);
    let beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent changed\n", "utf8");
    let afterRun = await gitChangedFileSnapshot(tempDir);
    let changedFiles = changedFilesBetween(beforeRun, afterRun);
    let validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/blocked.txt"]);
    let rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    const scopeWriterPlan = validateSingleLockPlan({
      agent: "builder",
      task: "Edit through Scope Contract.",
      write: true,
      lockedPaths: ["src"],
      scope: {
        read: ["src"],
        write: ["src/allowed.txt"],
        forbidden: ["src/forbidden.txt"],
      },
    }).lockPlan;
    scopeWriterPlan.cwd = tempDir;
    assert.deepEqual(scopeWriterPlan.allowedEdits, ["src/allowed.txt"]);

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "outside scope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "scope_changed_file_violation");
    assert.deepEqual(validation.scopeViolations.outsideWriteScope, ["src/blocked.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "forbidden.txt"), "changed forbidden\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: scopeWriterPlan });
    assert.equal(changedFileValidationErrorType(validation), "scope_forbidden_file_violation");
    assert.deepEqual(validation.scopeViolations.forbiddenFiles, ["src/forbidden.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "forbidden.txt"), "utf8"), "secret\n");

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "created.txt"), "nope\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/created.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    await assert.rejects(readFile(path.join(tempDir, "src", "created.txt"), "utf8"));

    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await rm(path.join(tempDir, "src", "blocked.txt"), { force: true });
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "clean\n");

    await writeFile(path.join(tempDir, "src", "blocked.txt"), "user dirty\n", "utf8");
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "blocked.txt"), "agent overwrote dirty file\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: writerPlan });
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
    assert.equal(await readFile(path.join(tempDir, "src", "blocked.txt"), "utf8"), "user dirty\n");

    const readOnlyPlan = validateSingleLockPlan({
      agent: "reviewer",
      task: "Review only.",
    }).lockPlan;
    readOnlyPlan.cwd = tempDir;
    rollbackBaseline = await captureRollbackBaseline(tempDir);
    beforeRun = await gitChangedFileSnapshot(tempDir);
    await writeFile(path.join(tempDir, "src", "allowed.txt"), "reviewer edited\n", "utf8");
    afterRun = await gitChangedFileSnapshot(tempDir);
    changedFiles = changedFilesBetween(beforeRun, afterRun);
    validation = validateChangedFilesForPlan({ changedFiles, lockPlan: readOnlyPlan });
    assert.deepEqual(validation.disallowedFiles, ["src/allowed.txt"]);
    rollback = await rollbackUnsafeChanges({ cwd: tempDir, baseline: rollbackBaseline, files: validation.disallowedFiles });
    assert.equal(rollback.rollback, "success");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log("Self tests passed.");
}

if (process.argv.includes("--self-test")) {
  await runSelfTests();
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
