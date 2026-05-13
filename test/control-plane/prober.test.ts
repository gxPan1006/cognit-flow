import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "../../src/control-plane/registry.js";
import { Prober } from "../../src/control-plane/prober.js";

describe("control-plane prober", () => {
  let dir: string;
  let persistencePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-prober-test-"));
    persistencePath = path.join(dir, "projects.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("marks runtimes running when probe succeeds and stopped on connection refused", async () => {
    const registry = new Registry({ persistencePath });
    await registry.load();

    await registry.register({
      name: "demo",
      projectPath: "/tmp",
      workflowPath: "/tmp/WORKFLOW.md",
      runnerPath: "/tmp/run.sh",
      tmuxSession: "demo",
      port: 5111,
      codingTool: "claude",
      workspaceRoot: "/tmp/ws",
    });

    let mode: "ok" | "refused" | "error" = "ok";
    const prober = new Prober({
      registry,
      requestFn: async () => {
        if (mode === "ok") return { ok: true, body: { runningCount: 1 } };
        if (mode === "refused") return { ok: false, reason: "connection_refused" };
        return { ok: false, reason: "boom" };
      },
    });

    await prober.probeOnce();
    expect(registry.fetch("demo-5111")?.status).toBe("running");
    expect(registry.fetch("demo-5111")?.lastState).toEqual({ runningCount: 1 });

    mode = "refused";
    await prober.probeOnce();
    expect(registry.fetch("demo-5111")?.status).toBe("stopped");

    mode = "error";
    await prober.probeOnce();
    expect(registry.fetch("demo-5111")?.status).toBe("error");
    expect(registry.fetch("demo-5111")?.lastError).toBe("boom");
  });
});
