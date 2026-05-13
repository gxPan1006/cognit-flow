import { describe, expect, it, vi } from "vitest";
import { defaultDynamicTool } from "../../../src/coding-tool/codex/dynamic-tool.js";
import type { LinearClient } from "../../../src/linear/client.js";

function stubClient(graphql: LinearClient["graphql"]): LinearClient {
  return {
    fetchCandidateIssues: async () => ({ ok: true, value: [] }),
    fetchIssuesByStates: async () => ({ ok: true, value: [] }),
    fetchIssueStatesByIds: async () => ({ ok: true, value: [] }),
    graphql,
  };
}

describe("Codex dynamic tool", () => {
  it("advertises linear_graphql in its tool specs", () => {
    const tool = defaultDynamicTool();
    const specs = tool.toolSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe("linear_graphql");
  });

  it("executes a successful Linear query", async () => {
    const graphql = vi.fn(async () => ({
      ok: true as const,
      value: { data: { issues: { nodes: [{ id: "abc" }] } } },
    }));
    const tool = defaultDynamicTool(stubClient(graphql));
    const result = await tool.execute("linear_graphql", { query: "{ issues { nodes { id } } }" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("\"id\": \"abc\"");
  });

  it("flags a Linear errors[] response as unsuccessful", async () => {
    const graphql = vi.fn(async () => ({
      ok: true as const,
      value: { errors: [{ message: "bad" }] },
    }));
    const tool = defaultDynamicTool(stubClient(graphql));
    const result = await tool.execute("linear_graphql", { query: "{ x }" });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported tool names", async () => {
    const tool = defaultDynamicTool();
    const result = await tool.execute("not_a_tool", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsupported dynamic tool");
  });

  it("rejects missing query", async () => {
    const tool = defaultDynamicTool();
    const result = await tool.execute("linear_graphql", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("non-empty `query`");
  });

  it("rejects invalid variables", async () => {
    const tool = defaultDynamicTool();
    const result = await tool.execute("linear_graphql", { query: "{ x }", variables: "not-an-object" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("must be a JSON object");
  });

  it("accepts a raw query string", async () => {
    const graphql = vi.fn(async () => ({ ok: true as const, value: { data: {} } }));
    const tool = defaultDynamicTool(stubClient(graphql));
    const result = await tool.execute("linear_graphql", "{ viewer { id } }");
    expect(result.success).toBe(true);
    expect(graphql).toHaveBeenCalledWith("{ viewer { id } }", {});
  });
});
