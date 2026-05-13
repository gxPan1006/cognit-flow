import { describe, expect, it, vi } from "vitest";
import { makeAdapter } from "../../src/linear/adapter.js";
import type { LinearClient } from "../../src/linear/client.js";

function stubClient(graphql: LinearClient["graphql"]): LinearClient {
  return {
    fetchCandidateIssues: async () => ({ ok: true, value: [] }),
    fetchIssuesByStates: async () => ({ ok: true, value: [] }),
    fetchIssueStatesByIds: async () => ({ ok: true, value: [] }),
    graphql,
  };
}

describe("linear adapter write paths", () => {
  it("createComment returns ok when GraphQL reports success", async () => {
    const graphql = vi.fn(async () => ({
      ok: true as const,
      value: { data: { commentCreate: { success: true } } },
    }));
    const adapter = makeAdapter(stubClient(graphql));
    const result = await adapter.createComment("issue-1", "body");
    expect(result.ok).toBe(true);
    expect(graphql).toHaveBeenCalledOnce();
  });

  it("createComment returns error when GraphQL reports success=false", async () => {
    const graphql = vi.fn(async () => ({
      ok: true as const,
      value: { data: { commentCreate: { success: false } } },
    }));
    const adapter = makeAdapter(stubClient(graphql));
    const result = await adapter.createComment("issue-1", "body");
    expect(result.ok).toBe(false);
  });

  it("updateIssueState resolves state name to id then mutates", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("CognitFlowResolveStateId")) {
        return {
          ok: true as const,
          value: {
            data: { issue: { team: { states: { nodes: [{ id: "state-id-42" }] } } } },
          },
        };
      }
      return { ok: true as const, value: { data: { issueUpdate: { success: true } } } };
    });
    const adapter = makeAdapter(stubClient(graphql));
    const result = await adapter.updateIssueState("issue-1", "In Progress");
    expect(result.ok).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("updateIssueState returns error when state lookup misses", async () => {
    const graphql = vi.fn(async () => ({
      ok: true as const,
      value: { data: { issue: { team: { states: { nodes: [] } } } } },
    }));
    const adapter = makeAdapter(stubClient(graphql));
    const result = await adapter.updateIssueState("issue-1", "Unknown State");
    expect(result.ok).toBe(false);
  });
});
