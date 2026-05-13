import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../src/control-plane/index.js";

describe("control plane HTTP server", () => {
  let dir: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-cp-http-test-"));
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers a project via POST and lists it via GET", async () => {
    const server = await start({
      port: 0,
      persistencePath: path.join(dir, "projects.json"),
      probeIntervalMs: 60_000,
    });
    stop = server.stop;

    const base = `http://${server.address.host}:${server.address.port}`;
    const register = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "demo",
        projectPath: "/tmp/demo",
        workflowPath: "/tmp/demo/WORKFLOW.md",
        runnerPath: "/tmp/demo/run.sh",
        tmuxSession: "demo-7001",
        port: 7001,
        codingTool: "claude",
        workspaceRoot: "/tmp/demo-ws",
      }),
    });
    expect(register.status).toBe(201);
    const entry = (await register.json()) as { id: string };
    expect(entry.id).toBe("demo-7001");

    const list = await fetch(`${base}/api/projects`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.id).toBe("demo-7001");

    const del = await fetch(`${base}/api/projects/demo-7001`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const empty = await fetch(`${base}/api/projects`);
    const emptyBody = (await empty.json()) as { projects: unknown[] };
    expect(emptyBody.projects).toHaveLength(0);
  });

  it("returns 400 for invalid registration", async () => {
    const server = await start({
      port: 0,
      persistencePath: path.join(dir, "projects.json"),
      probeIntervalMs: 60_000,
    });
    stop = server.stop;

    const base = `http://${server.address.host}:${server.address.port}`;
    const result = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", port: 0 }),
    });
    expect(result.status).toBe(400);
  });

  it("returns 404 for start on unknown project", async () => {
    const server = await start({
      port: 0,
      persistencePath: path.join(dir, "projects.json"),
      probeIntervalMs: 60_000,
    });
    stop = server.stop;

    const base = `http://${server.address.host}:${server.address.port}`;
    const result = await fetch(`${base}/api/projects/does-not-exist/start`, { method: "POST" });
    expect(result.status).toBe(404);
  });
});
