import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry, type RegisterAttrs } from "../../src/control-plane/registry.js";

describe("control-plane registry", () => {
  let dir: string;
  let persistencePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-registry-test-"));
    persistencePath = path.join(dir, "projects.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseAttrs: RegisterAttrs = {
    name: "demo",
    projectPath: "/tmp/demo",
    workflowPath: "/tmp/demo/WORKFLOW.md",
    runnerPath: "/tmp/demo/run.sh",
    tmuxSession: "demo-4001",
    port: 4001,
    codingTool: "claude",
    workspaceRoot: "/tmp/demo-ws",
  };

  it("registers, fetches, lists, unregisters, and persists across reload", async () => {
    const registry = new Registry({ persistencePath });
    await registry.load();

    const result = await registry.register(baseAttrs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.id).toBe("demo-4001");
    expect(registry.list()).toHaveLength(1);
    expect(registry.fetch(result.entry.id)?.name).toBe("demo");

    // Reload from disk and confirm persistence.
    const reloaded = new Registry({ persistencePath });
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.fetch("demo-4001")?.port).toBe(4001);

    await registry.unregister(result.entry.id);
    expect(registry.list()).toHaveLength(0);
    const afterDelete = new Registry({ persistencePath });
    await afterDelete.load();
    expect(afterDelete.list()).toHaveLength(0);
  });

  it("validates required fields", async () => {
    const registry = new Registry({ persistencePath });
    await registry.load();
    const result = await registry.register({ ...baseAttrs, name: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing_field");
  });

  it("validates port", async () => {
    const registry = new Registry({ persistencePath });
    await registry.load();
    const result = await registry.register({ ...baseAttrs, port: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid_field");
  });

  it("broadcasts events to subscribers", async () => {
    const registry = new Registry({ persistencePath });
    await registry.load();
    const events: string[] = [];
    registry.subscribe((event) => events.push(event.kind));

    const result = await registry.register(baseAttrs);
    expect(result.ok).toBe(true);
    registry.updateRuntimeState("demo-4001", { status: "running" });
    await registry.unregister("demo-4001");

    expect(events).toEqual([
      "project_registered",
      "project_runtime_changed",
      "project_unregistered",
    ]);
  });
});
