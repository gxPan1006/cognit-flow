import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { StatusDashboard } from "../../src/status-dashboard/index.js";
import { start } from "../../src/http-server/index.js";
import { setTrackerAdapter } from "../../src/tracker/index.js";
import { InMemoryTracker } from "../../src/tracker/memory.js";
import { workflowStore } from "../../src/workflow/store.js";

/**
 * HTTP server smoke tests — verifies the dashboard HTML renders, the JSON
 * snapshot endpoint works, and the SSE stream emits at least one event.
 */

describe("HTTP server", () => {
  let root: string;
  let memory: InMemoryTracker;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-http-test-"));
    memory = new InMemoryTracker();
    setTrackerAdapter(memory);
    workflowStore.set({
      config: {
        tracker: { kind: "memory", project_slug: "TEST" },
        workspace: { root },
        polling: { interval_ms: 1000 },
        coding_tool: { kind: "claude" },
        claude: {
          command: "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"x\"}'",
          turn_timeout_ms: 5_000,
          stall_timeout_ms: 5_000,
        },
        agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 60_000 },
        hooks: { timeout_ms: 5_000 },
      },
      prompt: "",
      promptTemplate: "",
    });
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
    setTrackerAdapter(null);
    workflowStore.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves /healthz, /, /api/snapshot", async () => {
    const orchestrator = new Orchestrator();
    const dashboard = new StatusDashboard(orchestrator, { refreshMs: 200 });
    dashboard.start();

    const server = await start({ port: 0, dashboard });
    stop = server.stop;

    const base = `http://${server.address.host}:${server.address.port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const html = await fetch(`${base}/`);
    expect(html.status).toBe(200);
    const body = await html.text();
    expect(body).toContain("Cognit Flow · Status");
    expect(body).toContain("EventSource");

    const api = await fetch(`${base}/api/snapshot`);
    expect(api.status).toBe(200);
    const json = (await api.json()) as { metrics: { runningCount: number } };
    expect(json.metrics.runningCount).toBe(0);

    dashboard.stop();
  });

  it("pushes snapshots over SSE", async () => {
    const orchestrator = new Orchestrator();
    const dashboard = new StatusDashboard(orchestrator, { refreshMs: 100 });
    dashboard.start();
    const server = await start({ port: 0, dashboard });
    stop = server.stop;

    const base = `http://${server.address.host}:${server.address.port}`;

    const controller = new AbortController();
    const response = await fetch(`${base}/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let events = 0;
    while (events < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith("data:")) events++;
      }
    }
    expect(events).toBeGreaterThanOrEqual(2);
    controller.abort();
    dashboard.stop();
  });
});
