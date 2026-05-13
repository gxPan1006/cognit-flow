import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/coding-tool/codex/adapter.js";
import type { CodingToolEvent } from "../../../src/coding-tool/adapter.js";
import { makeIssue } from "../../../src/linear/issue.js";
import { workflowStore } from "../../../src/workflow/store.js";

const FAKE_SERVER = path.resolve(__dirname, "fake-server.sh");

describe("Codex adapter (fake app-server)", () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-codex-test-"));
    workspace = path.join(root, "CDX-1");
    fs.mkdirSync(workspace, { recursive: true });
    workflowStore.set({
      config: {
        workspace: { root },
        coding_tool: { kind: "codex" },
        codex: {
          command: `bash ${FAKE_SERVER}`,
          approval_policy: "never",
          thread_sandbox: "workspace-write",
          turn_timeout_ms: 10_000,
          read_timeout_ms: 5_000,
          stall_timeout_ms: 5_000,
          turn_sandbox_policy: {
            type: "workspaceWrite",
            writableRoots: [workspace],
            readOnlyAccess: { type: "fullAccess" },
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      },
      prompt: "",
      promptTemplate: "",
    });
  });

  afterEach(() => {
    workflowStore.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("performs the full initialize → thread/start → turn/start → turn/completed handshake", async () => {
    const adapter = new CodexAdapter();
    const started = await adapter.startSession(workspace);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.threadId).toBe("thread-fake");

    const issue = makeIssue({ id: "i1", identifier: "CDX-1", title: "T", state: "Todo" });
    const events: CodingToolEvent[] = [];
    const result = await adapter.runTurn(started.value, "do work", issue, {
      onMessage: (event) => {
        events.push(event);
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turnId).toBe("turn-fake");
    expect(result.value.sessionId).toBe("thread-fake-turn-fake");

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("session_started");
    expect(kinds).toContain("turn_completed");
    await adapter.stopSession(started.value);
  });

  it("rejects remote worker hosts", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.startSession(workspace, { workerHost: "remote-host" });
    expect(result.ok).toBe(false);
  });
});
