import { load } from "../workflow/loader.js";
import { workflowStore } from "../workflow/store.js";
import {
  parse,
  resolveRuntimeTurnSandboxPolicy,
  type Settings,
  type SandboxPolicyResult,
} from "./schema.js";

/**
 * High-level runtime configuration accessors.
 *  — wraps Workflow loader + Schema.parse and applies
 * runtime overrides for port / language.
 */

export interface CognitFlowRuntimeEnv {
  language?: string | null;
  serverPortOverride?: number | null;
}

const env: CognitFlowRuntimeEnv = {};

export function setLanguage(value: string | null): void {
  env.language = value;
}

export function language(): string | null {
  const v = env.language;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function setServerPortOverride(value: number | null): void {
  env.serverPortOverride = value;
}

export type SettingsResult =
  | { ok: true; value: Settings }
  | { ok: false; error: unknown };

/**
 * Return parsed Settings, reading from the workflow store if running, otherwise
 * doing a one-shot load. /0.
 */
export async function settings(): Promise<SettingsResult> {
  const cached = workflowStore.current();
  if (cached) {
    return parse(cached.config);
  }
  const loaded = await load();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return parse(loaded.value.config);
}

export async function settingsOrThrow(): Promise<Settings> {
  const result = await settings();
  if (!result.ok) {
    throw new Error(`Invalid WORKFLOW.md config: ${formatError(result.error)}`);
  }
  return result.value;
}

export async function maxConcurrentAgentsForState(stateName: string): Promise<number> {
  const s = await settingsOrThrow();
  const normalized = stateName.toLowerCase();
  return s.agent.max_concurrent_agents_by_state[normalized] ?? s.agent.max_concurrent_agents;
}

export async function codexTurnSandboxPolicy(
  workspace?: string,
): Promise<Record<string, unknown>> {
  const s = await settingsOrThrow();
  const result: SandboxPolicyResult = resolveRuntimeTurnSandboxPolicy(s, workspace);
  if (!result.ok) {
    throw new Error(`Invalid codex turn sandbox policy: ${JSON.stringify(result.error)}`);
  }
  return result.policy;
}

export async function codingToolKind(): Promise<string> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind || "codex";
}

export async function activeToolTurnTimeoutMs(): Promise<number> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind === "claude"
    ? s.claude.turn_timeout_ms
    : s.codex.turn_timeout_ms;
}

export async function activeToolStallTimeoutMs(): Promise<number> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind === "claude"
    ? s.claude.stall_timeout_ms
    : s.codex.stall_timeout_ms;
}

export async function serverPort(): Promise<number | null> {
  const override = env.serverPortOverride;
  if (typeof override === "number" && override >= 0) return override;
  const s = await settingsOrThrow();
  return s.server.port ?? null;
}

const DEFAULT_PROMPT_TEMPLATE = `You are working on a Linear issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

/**
 * The effective prompt template — workflow body if present, otherwise the
 * built-in minimal default. Mirrors Config.workflow_prompt/0.
 */
export async function workflowPrompt(): Promise<string> {
  const cached = workflowStore.current();
  const tmpl = cached?.promptTemplate;
  if (typeof tmpl === "string" && tmpl.trim() !== "") return tmpl;

  const loaded = await load();
  if (loaded.ok && loaded.value.promptTemplate.trim() !== "") {
    return loaded.value.promptTemplate;
  }
  return DEFAULT_PROMPT_TEMPLATE;
}

export type ValidationError =
  | { kind: "missing_tracker_kind" }
  | { kind: "unsupported_tracker_kind"; value: string }
  | { kind: "missing_linear_api_token" }
  | { kind: "missing_linear_project_slug" }
  | { kind: "unsupported_coding_tool"; value: string };

export async function validateSemantics(): Promise<{ ok: true } | { ok: false; error: ValidationError }> {
  const s = await settingsOrThrow();
  if (!s.tracker.kind) return { ok: false, error: { kind: "missing_tracker_kind" } };
  if (s.tracker.kind !== "linear" && s.tracker.kind !== "memory") {
    return { ok: false, error: { kind: "unsupported_tracker_kind", value: s.tracker.kind } };
  }
  if (s.tracker.kind === "linear" && typeof s.tracker.api_key !== "string") {
    return { ok: false, error: { kind: "missing_linear_api_token" } };
  }
  if (s.tracker.kind === "linear" && typeof s.tracker.project_slug !== "string") {
    return { ok: false, error: { kind: "missing_linear_project_slug" } };
  }
  if (s.coding_tool.kind !== "codex" && s.coding_tool.kind !== "claude") {
    return { ok: false, error: { kind: "unsupported_coding_tool", value: s.coding_tool.kind } };
  }
  return { ok: true };
}

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; message?: string; path?: string };
    if (e.kind === "missing_workflow_file" && e.path) {
      return `Missing WORKFLOW.md at ${e.path}`;
    }
    if (e.kind === "invalid_workflow_config" && e.message) {
      return e.message;
    }
  }
  return JSON.stringify(error);
}
