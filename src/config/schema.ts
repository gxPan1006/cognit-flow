import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { canonicalize } from "../path-safety.js";

/**
 * Typed configuration schema parsed from WORKFLOW.md front matter.
 *  (614 LOC of Ecto changesets).
 *
 * Defaults match the Elixir implementation exactly. Unknown top-level keys are
 * ignored for forward compatibility (Zod's default behavior with passthrough).
 */

const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "cognit-flow-workspaces");

const DEFAULT_TRACKER_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_TRACKER_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

const DEFAULT_CLAUDE_COMMAND =
  "claude --print --verbose --output-format stream-json --permission-mode bypassPermissions";

const DEFAULT_CODEX_APPROVAL_POLICY: Record<string, unknown> = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
  },
};

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const trackerSchema = z
  .object({
    kind: z.string().optional(),
    endpoint: z.string().default("https://api.linear.app/graphql"),
    api_key: z.string().optional(),
    project_slug: z.string().optional(),
    assignee: z.string().optional(),
    active_states: z.array(z.string()).default([...DEFAULT_TRACKER_ACTIVE_STATES]),
    terminal_states: z.array(z.string()).default([...DEFAULT_TRACKER_TERMINAL_STATES]),
  })
  .passthrough();

const pollingSchema = z
  .object({
    interval_ms: positiveInt.default(30_000),
  })
  .passthrough();

const workspaceSchema = z
  .object({
    root: z.string().default(DEFAULT_WORKSPACE_ROOT),
  })
  .passthrough();

const workerSchema = z
  .object({
    ssh_hosts: z.array(z.string()).default([]),
    max_concurrent_agents_per_host: positiveInt.optional(),
  })
  .passthrough();

const agentSchema = z
  .object({
    max_concurrent_agents: positiveInt.default(10),
    max_turns: positiveInt.default(20),
    max_retry_backoff_ms: positiveInt.default(300_000),
    max_concurrent_agents_by_state: z.record(z.string(), z.number()).default({}),
  })
  .passthrough();

const codingToolSchema = z
  .object({
    kind: z.string().default("codex"),
  })
  .passthrough();

const codexSchema = z
  .object({
    command: z.string().default("codex app-server"),
    approval_policy: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .default(DEFAULT_CODEX_APPROVAL_POLICY),
    thread_sandbox: z.string().default("workspace-write"),
    turn_sandbox_policy: z.record(z.string(), z.unknown()).nullable().optional(),
    turn_timeout_ms: positiveInt.default(3_600_000),
    read_timeout_ms: positiveInt.default(5_000),
    stall_timeout_ms: nonNegativeInt.default(300_000),
  })
  .passthrough();

const claudeSchema = z
  .object({
    command: z.string().default(DEFAULT_CLAUDE_COMMAND),
    turn_timeout_ms: positiveInt.default(3_600_000),
    stall_timeout_ms: nonNegativeInt.default(300_000),
  })
  .passthrough();

const hooksSchema = z
  .object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
    timeout_ms: positiveInt.default(60_000),
  })
  .passthrough();

const observabilitySchema = z
  .object({
    dashboard_enabled: z.boolean().default(true),
    refresh_ms: positiveInt.default(1_000),
    render_interval_ms: positiveInt.default(16),
  })
  .passthrough();

const serverSchema = z
  .object({
    port: nonNegativeInt.optional(),
    host: z.string().default("127.0.0.1"),
  })
  .passthrough();

const rootSchema = z
  .object({
    tracker: trackerSchema.default({}),
    polling: pollingSchema.default({}),
    workspace: workspaceSchema.default({}),
    worker: workerSchema.default({}),
    agent: agentSchema.default({}),
    coding_tool: codingToolSchema.default({}),
    codex: codexSchema.default({}),
    claude: claudeSchema.default({}),
    hooks: hooksSchema.default({}),
    observability: observabilitySchema.default({}),
    server: serverSchema.default({}),
  })
  .passthrough();

export type Settings = z.infer<typeof rootSchema>;

export type ParseError = { kind: "invalid_workflow_config"; message: string };
export type ParseResult = { ok: true; value: Settings } | { ok: false; error: ParseError };

/**
 * Parse raw WORKFLOW.md front matter into typed settings.
 * /1.
 */
export function parse(rawConfig: unknown): ParseResult {
  const normalized = dropNullDeep(normalizeKeys(rawConfig));
  const result = rootSchema.safeParse(normalized ?? {});
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: "invalid_workflow_config",
        message: formatZodErrors(result.error),
      },
    };
  }
  return { ok: true, value: finalizeSettings(result.data) };
}

/**
 * Normalize state name for lookup comparisons.
 */
export function normalizeIssueState(stateName: string): string {
  return stateName.toLowerCase();
}

function finalizeSettings(settings: Settings): Settings {
  const trackerApiKey = resolveSecret(settings.tracker.api_key, process.env.LINEAR_API_KEY);
  const trackerAssignee = resolveSecret(settings.tracker.assignee, process.env.LINEAR_ASSIGNEE);
  const workspaceRoot = resolvePath(settings.workspace.root, DEFAULT_WORKSPACE_ROOT);
  const codingToolKind = normalizeToolKind(settings.coding_tool.kind);
  const normalizedStateLimits = normalizeStateLimits(
    settings.agent.max_concurrent_agents_by_state,
  );

  const next: Settings = {
    ...settings,
    tracker: { ...settings.tracker, api_key: trackerApiKey, assignee: trackerAssignee },
    workspace: { ...settings.workspace, root: workspaceRoot },
    agent: { ...settings.agent, max_concurrent_agents_by_state: normalizedStateLimits },
    coding_tool: { ...settings.coding_tool, kind: codingToolKind },
    codex: {
      ...settings.codex,
      approval_policy: settings.codex.approval_policy,
      turn_sandbox_policy: settings.codex.turn_sandbox_policy ?? null,
    },
  };
  return next;
}

function normalizeStateLimits(limits: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [state, limit] of Object.entries(limits)) {
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
      out[normalizeIssueState(state)] = limit;
    }
  }
  return out;
}

function normalizeToolKind(kind: string | undefined): string {
  return (kind ?? "codex").trim().toLowerCase();
}

// ---- secret / env / path helpers (mirror Elixir behaviors) ----

function resolveSecret(value: string | undefined, fallback: string | undefined): string | undefined {
  if (value === undefined) {
    return normalizeNonEmpty(fallback);
  }
  const resolved = resolveEnvValue(value, fallback);
  return normalizeNonEmpty(resolved);
}

function resolvePath(value: string, fallback: string): string {
  const token = normalizePathToken(value);
  if (token === undefined || token === "") return fallback;
  return token;
}

function normalizePathToken(value: string): string | undefined {
  const envName = envReferenceName(value);
  if (envName === null) return value;
  const resolved = process.env[envName];
  if (resolved === undefined) return undefined;
  return resolved;
}

function resolveEnvValue(value: string, fallback: string | undefined): string | undefined {
  const envName = envReferenceName(value);
  if (envName === null) return value;
  const fromEnv = process.env[envName];
  if (fromEnv === undefined) return fallback;
  if (fromEnv === "") return undefined;
  return fromEnv;
}

function envReferenceName(value: string): string | null {
  if (!value.startsWith("$")) return null;
  const name = value.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return value;
}

// ---- top-level key normalization ----

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[String(key)] = normalizeKeys(nested);
    }
    return out;
  }
  return value;
}

function dropNullDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = dropNullDeep(nested);
      if (cleaned !== null && cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out;
  }
  return value;
}

function formatZodErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join(", ");
}

// ---- runtime turn sandbox policy ----

export type TurnSandboxPolicy = Record<string, unknown> & {
  type: "workspaceWrite";
  writableRoots: string[];
  readOnlyAccess: { type: "fullAccess" };
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
};

export type SandboxPolicyResult =
  | { ok: true; policy: Record<string, unknown> }
  | { ok: false; error: { kind: "unsafe_turn_sandbox_policy"; reason: unknown } };

/**
 * Resolve the effective Codex turn sandbox policy at runtime.
 * Mirrors Schema.resolve_runtime_turn_sandbox_policy/3.
 */
export function resolveRuntimeTurnSandboxPolicy(
  settings: Settings,
  workspace: string | undefined,
  opts: { remote?: boolean } = {},
): SandboxPolicyResult {
  const explicit = settings.codex.turn_sandbox_policy;
  if (explicit && typeof explicit === "object") {
    return { ok: true, policy: explicit };
  }

  const root = workspace && workspace !== "" ? workspace : settings.workspace.root;
  if (opts.remote) {
    return { ok: true, policy: defaultTurnSandboxPolicy(root) };
  }

  const expanded = expandLocalWorkspaceRoot(root);
  const canon = canonicalize(expanded);
  if (!canon.ok) {
    return {
      ok: false,
      error: { kind: "unsafe_turn_sandbox_policy", reason: canon.reason },
    };
  }
  return { ok: true, policy: defaultTurnSandboxPolicy(canon.path) };
}

function expandLocalWorkspaceRoot(workspaceRoot: string | undefined): string {
  if (!workspaceRoot || workspaceRoot === "") {
    return path.resolve(DEFAULT_WORKSPACE_ROOT);
  }
  return path.resolve(workspaceRoot.startsWith("~") ? expandHome(workspaceRoot) : workspaceRoot);
}

function expandHome(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, input.slice(1));
  }
  return input;
}

function defaultTurnSandboxPolicy(workspaceRoot: string): TurnSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [workspaceRoot],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
