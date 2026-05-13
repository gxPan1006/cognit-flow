import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createForIssue,
  remove,
  runAfterRunHook,
  runBeforeRunHook,
} from "../../src/workspace/index.js";
import { workflowStore } from "../../src/workflow/store.js";

describe("workspace manager", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-ws-test-"));
    workflowStore.set({
      config: {
        workspace: { root },
        hooks: { timeout_ms: 10_000 },
      },
      prompt: "",
      promptTemplate: "",
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    workflowStore.reset();
  });

  it("creates a new workspace dir for an issue and reports createdNow", async () => {
    const result = await createForIssue({ id: "i1", identifier: "ABC-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(result.value)).toBe(true);
    expect(path.basename(result.value)).toBe("ABC-1");
  });

  it("sanitizes identifiers with unsafe characters", async () => {
    const result = await createForIssue({ id: "i1", identifier: "foo/bar baz" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.basename(result.value)).toBe("foo_bar_baz");
  });

  it("reuses an existing workspace directory", async () => {
    const first = await createForIssue({ id: "i1", identifier: "REUSE-1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    fs.writeFileSync(path.join(first.value, "sentinel.txt"), "keep");

    const second = await createForIssue({ id: "i1", identifier: "REUSE-1" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fs.existsSync(path.join(second.value, "sentinel.txt"))).toBe(true);
  });

  it("runs after_create hook only when the workspace is newly created", async () => {
    workflowStore.set({
      config: {
        workspace: { root },
        hooks: {
          after_create: "touch ./after-create-marker",
          timeout_ms: 10_000,
        },
      },
      prompt: "",
      promptTemplate: "",
    });

    const first = await createForIssue({ id: "i1", identifier: "HOOK-1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fs.existsSync(path.join(first.value, "after-create-marker"))).toBe(true);

    fs.unlinkSync(path.join(first.value, "after-create-marker"));

    const second = await createForIssue({ id: "i1", identifier: "HOOK-1" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fs.existsSync(path.join(second.value, "after-create-marker"))).toBe(false);
  });

  it("propagates hook failure as workspace_hook_failed when after_create exits non-zero", async () => {
    workflowStore.set({
      config: {
        workspace: { root },
        hooks: {
          after_create: "exit 17",
          timeout_ms: 5_000,
        },
      },
      prompt: "",
      promptTemplate: "",
    });
    const result = await createForIssue({ id: "i1", identifier: "FAIL-HOOK" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("workspace_hook_failed");
    if (result.error.kind !== "workspace_hook_failed") return;
    expect(result.error.status).toBe(17);
    expect(result.error.hook).toBe("after_create");
  });

  it(
    "times out a hook that exceeds the configured timeout",
    async () => {
      workflowStore.set({
        config: {
          workspace: { root },
          hooks: {
            after_create: "sleep 30",
            timeout_ms: 200,
          },
        },
        prompt: "",
        promptTemplate: "",
      });
      const result = await createForIssue({ id: "i1", identifier: "TIMEOUT-HOOK" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("workspace_hook_timeout");
    },
    // On Linux CI, execa's default forceKillAfterDelay (~5s) means the
    // timed-out hook's subprocess can hang around longer than vitest's
    // default 5s test timeout. Give the test plenty of headroom.
    15_000,
  );

  it("runs before_run hook on demand and propagates failures", async () => {
    const created = await createForIssue({ id: "i1", identifier: "BEFORE-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    workflowStore.set({
      config: {
        workspace: { root },
        hooks: { before_run: "exit 1", timeout_ms: 5_000 },
      },
      prompt: "",
      promptTemplate: "",
    });

    const result = await runBeforeRunHook(created.value, { id: "i1", identifier: "BEFORE-1" });
    expect(result.ok).toBe(false);
  });

  it("swallows after_run hook failures (logged but ignored)", async () => {
    const created = await createForIssue({ id: "i1", identifier: "AFTER-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    workflowStore.set({
      config: {
        workspace: { root },
        hooks: { after_run: "exit 99", timeout_ms: 5_000 },
      },
      prompt: "",
      promptTemplate: "",
    });

    const result = await runAfterRunHook(created.value, { id: "i1", identifier: "AFTER-1" });
    expect(result.ok).toBe(true);
  });

  it("removes a workspace cleanly", async () => {
    const created = await createForIssue({ id: "i1", identifier: "RM-1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await remove(created.value);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(created.value)).toBe(false);
  });

  it("rejects remote worker host (not yet supported)", async () => {
    const result = await createForIssue({ id: "i1", identifier: "REMOTE-1" }, "ssh-host-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("remote_unsupported");
  });
});
