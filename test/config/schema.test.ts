import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeIssueState, parse, resolveRuntimeTurnSandboxPolicy } from "../../src/config/schema.js";

describe("config schema", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("applies all defaults when given an empty config", () => {
    const result = parse({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value;
    expect(s.polling.interval_ms).toBe(30_000);
    expect(s.agent.max_concurrent_agents).toBe(10);
    expect(s.agent.max_turns).toBe(20);
    expect(s.agent.max_retry_backoff_ms).toBe(300_000);
    expect(s.codex.command).toBe("codex app-server");
    expect(s.codex.turn_timeout_ms).toBe(3_600_000);
    expect(s.codex.stall_timeout_ms).toBe(300_000);
    expect(s.coding_tool.kind).toBe("codex");
    expect(s.tracker.active_states).toEqual(["Todo", "In Progress"]);
  });

  it("resolves $VAR_NAME references against process.env", () => {
    process.env.MY_LINEAR_TOKEN = "abc123";
    const result = parse({ tracker: { api_key: "$MY_LINEAR_TOKEN" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.api_key).toBe("abc123");
  });

  it("falls back to LINEAR_API_KEY env var when api_key is missing", () => {
    process.env.LINEAR_API_KEY = "fallback-token";
    const result = parse({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.api_key).toBe("fallback-token");
  });

  it("treats empty $VAR resolution as missing", () => {
    process.env.EMPTY_VAR = "";
    const result = parse({ tracker: { api_key: "$EMPTY_VAR" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.api_key).toBe(undefined);
  });

  it("normalizes coding_tool.kind to lowercase trimmed", () => {
    const result = parse({ coding_tool: { kind: " CLAUDE " } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.coding_tool.kind).toBe("claude");
  });

  it("normalizes state limit map keys to lowercase, drops invalid entries", () => {
    const result = parse({
      agent: {
        max_concurrent_agents_by_state: {
          "In Progress": 3,
          Todo: -1,
          Merging: 2,
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agent.max_concurrent_agents_by_state).toEqual({
      "in progress": 3,
      merging: 2,
    });
  });

  it("rejects invalid polling.interval_ms", () => {
    const result = parse({ polling: { interval_ms: 0 } });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid agent.max_concurrent_agents", () => {
    const result = parse({ agent: { max_concurrent_agents: 0 } });
    expect(result.ok).toBe(false);
  });

  it("normalizes issue state for comparison", () => {
    expect(normalizeIssueState("In Progress")).toBe("in progress");
    expect(normalizeIssueState("TODO")).toBe("todo");
  });

  it("resolves remote turn sandbox policy without canonicalization", () => {
    const result = parse({ workspace: { root: "/tmp/cognition-ws-test" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const policy = resolveRuntimeTurnSandboxPolicy(result.value, undefined, { remote: true });
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.policy.type).toBe("workspaceWrite");
  });
});
