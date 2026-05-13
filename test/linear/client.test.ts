import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../src/config/index.js";
import { defaultClient } from "../../src/linear/client.js";
import { workflowStore } from "../../src/workflow/store.js";

describe("linear client (issue normalization + pagination)", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-token";
    workflowStore.set({
      config: {
        tracker: { kind: "linear", project_slug: "TEST-PROJ" },
      },
      prompt: "",
      promptTemplate: "",
    });
    setLanguage(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    workflowStore.reset();
    vi.restoreAllMocks();
  });

  it("normalizes issues and extracts blockers + labels", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "id-1",
                  identifier: "ABC-1",
                  title: "First",
                  description: "desc",
                  priority: 2,
                  state: { name: "Todo" },
                  branchName: "feat/x",
                  url: "https://linear.app/abc",
                  assignee: { id: "user-1" },
                  labels: { nodes: [{ name: "Bug" }, { name: "FRONTEND" }] },
                  inverseRelations: {
                    nodes: [
                      {
                        type: "blocks",
                        issue: { id: "blocker-1", identifier: "ABC-99", state: { name: "Todo" } },
                      },
                      {
                        type: "related",
                        issue: { id: "related-1", identifier: "ABC-100", state: { name: "Done" } },
                      },
                    ],
                  },
                  createdAt: "2024-01-01T00:00:00.000Z",
                  updatedAt: "2024-01-02T00:00:00.000Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await defaultClient().fetchCandidateIssues();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const issue = result.value[0]!;
    expect(issue.id).toBe("id-1");
    expect(issue.identifier).toBe("ABC-1");
    expect(issue.state).toBe("Todo");
    expect(issue.labels).toEqual(["bug", "frontend"]);
    expect(issue.blockedBy).toEqual([
      { id: "blocker-1", identifier: "ABC-99", state: "Todo" },
    ]);
    expect(issue.createdAt?.toISOString()).toBe("2024-01-01T00:00:00.000Z");

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("paginates until hasNextPage is false", async () => {
    const responses = [
      {
        nodes: [
          {
            id: "id-1",
            identifier: "ABC-1",
            title: "P1",
            state: { name: "Todo" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
      {
        nodes: [
          {
            id: "id-2",
            identifier: "ABC-2",
            title: "P2",
            state: { name: "Todo" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    let call = 0;
    const mockFetch = vi.fn(async () => {
      const body = JSON.stringify({ data: { issues: responses[call++] } });
      return new Response(body, { status: 200 });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await defaultClient().fetchCandidateIssues();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((i) => i.identifier)).toEqual(["ABC-1", "ABC-2"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns missing_linear_api_token when no token is configured", async () => {
    delete process.env.LINEAR_API_KEY;
    workflowStore.set({
      config: { tracker: { kind: "linear", project_slug: "TEST-PROJ" } },
      prompt: "",
      promptTemplate: "",
    });

    const result = await defaultClient().fetchCandidateIssues();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing_linear_api_token");
  });

  it("returns linear_graphql_errors when response contains errors", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await defaultClient().fetchCandidateIssues();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("linear_graphql_errors");
  });

  it("returns linear_api_status on non-200", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await defaultClient().fetchCandidateIssues();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("linear_api_status");
  });
});
