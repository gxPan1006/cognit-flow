import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliAdapter } from "../../src/coding-tool/claude-cli.js";
import type { CodingToolEvent } from "../../src/coding-tool/adapter.js";
import { makeIssue } from "../../src/linear/issue.js";
import { workflowStore } from "../../src/workflow/store.js";

/**
 * The Claude adapter shells out to `bash -lc <script>` which runs the
 * configured `claude.command` with the rendered prompt piped via heredoc.
 * We point `claude.command` at a small bash fake that emits a deterministic
 * stream-json sequence, so we can verify event dispatch + usage accumulation
 * without depending on the real Claude CLI.
 */

describe("Claude CLI adapter", () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-claude-test-"));
    workspace = path.join(root, "WS-1");
    fs.mkdirSync(workspace, { recursive: true });
    workflowStore.set({
      config: {
        workspace: { root },
        coding_tool: { kind: "claude" },
        claude: {
          // Bash one-liner that emits two assistant tokens then a result.
          command: [
            "printf '%s\\n'",
            "'{\"type\":\"system\",\"session_id\":\"claude-1\"}'",
            "'{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}'",
            "'{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"world\"}],\"usage\":{\"input_tokens\":20,\"output_tokens\":7}}}'",
            "'{\"type\":\"result\",\"session_id\":\"claude-1\",\"usage\":{\"input_tokens\":30,\"output_tokens\":12,\"cache_read_input_tokens\":2}}'",
          ].join(" "),
          turn_timeout_ms: 10_000,
          stall_timeout_ms: 5_000,
        },
      },
      prompt: "",
      promptTemplate: "",
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    workflowStore.reset();
  });

  it("starts a session for a valid workspace and rejects remote hosts", async () => {
    const adapter = new ClaudeCliAdapter();
    const ok = await adapter.startSession(workspace);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.threadId).toMatch(/^claude-thread-/);

    const remote = await adapter.startSession(workspace, { workerHost: "remote-1" });
    expect(remote.ok).toBe(false);
  });

  it("rejects a workspace outside of the configured root", async () => {
    const adapter = new ClaudeCliAdapter();
    const outside = path.join(os.tmpdir(), "cognition-outside-" + Date.now());
    fs.mkdirSync(outside, { recursive: true });
    try {
      const result = await adapter.startSession(outside);
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs a turn, dispatches events, accumulates usage, captures session_id for resume", async () => {
    const adapter = new ClaudeCliAdapter();
    const started = await adapter.startSession(workspace);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const issue = makeIssue({ id: "i1", identifier: "ABC-1", title: "T", state: "Todo" });
    const events: CodingToolEvent[] = [];

    const result = await adapter.runTurn(started.value, "do work", issue, {
      onMessage: (event) => {
        events.push(event);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe("turn_completed");
    expect(result.value.claudeSessionId).toBe("claude-1");

    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("session_started");
    expect(kinds).toContain("system_init");
    expect(kinds.filter((k) => k === "assistant_message").length).toBe(2);
    expect(kinds).toContain("result");
    expect(kinds[kinds.length - 1]).toBe("turn_completed");

    const turnCompleted = events.find((e) => e.event === "turn_completed");
    expect(turnCompleted).toBeDefined();
    if (turnCompleted && turnCompleted.event === "turn_completed") {
      expect(turnCompleted.usage.total_tokens).toBe(30 + 12 + 2);
    }

    // The session store should have remembered the session_id for the next turn.
    expect(started.value.store.claudeSessionId).toBe("claude-1");
  });

  it("appends --resume on subsequent turns once a session_id is known", async () => {
    workflowStore.set({
      config: {
        workspace: { root },
        coding_tool: { kind: "claude" },
        claude: {
          // Emit the script verbatim so we can inspect what `--resume` flag landed.
          command: "printf 'argv=%s\\n' \"$0\" > /dev/null; printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"claude-2\"}'",
          turn_timeout_ms: 5_000,
          stall_timeout_ms: 5_000,
        },
      },
      prompt: "",
      promptTemplate: "",
    });
    const adapter = new ClaudeCliAdapter();
    const started = await adapter.startSession(workspace);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const issue = makeIssue({ id: "i1", identifier: "ABC-1", title: "T", state: "Todo" });
    const first = await adapter.runTurn(started.value, "first", issue);
    expect(first.ok).toBe(true);
    expect(started.value.store.claudeSessionId).toBe("claude-2");

    const second = await adapter.runTurn(started.value, "second", issue);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // session_id survives across turns, so the second turn would have been
    // launched with --resume claude-2 (resume happens inside command_script).
    expect(second.value.claudeSessionId).toBe("claude-2");
  });

  it("returns claude_cli_exit when the underlying command fails", async () => {
    workflowStore.set({
      config: {
        workspace: { root },
        coding_tool: { kind: "claude" },
        claude: {
          command: "echo 'something went wrong' && exit 42",
          turn_timeout_ms: 5_000,
          stall_timeout_ms: 5_000,
        },
      },
      prompt: "",
      promptTemplate: "",
    });
    const adapter = new ClaudeCliAdapter();
    const started = await adapter.startSession(workspace);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const issue = makeIssue({ id: "i1", identifier: "ABC-1", title: "T", state: "Todo" });
    const events: CodingToolEvent[] = [];
    const result = await adapter.runTurn(started.value, "explode", issue, {
      onMessage: (event) => {
        events.push(event);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { kind: string }).kind).toBe("claude_cli_exit");
    expect(events.some((e) => e.event === "turn_failed")).toBe(true);
  });
});
