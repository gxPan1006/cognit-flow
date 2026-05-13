import * as crypto from "node:crypto";
import * as readline from "node:readline";
import * as path from "node:path";
import { execa } from "execa";
import { settingsOrThrow } from "../config/index.js";
import type { Issue } from "../linear/issue.js";
import { logger } from "../log-file.js";
import { canonicalize } from "../path-safety.js";
import type {
  AdapterResult,
  AdapterSession,
  CodingToolAdapter,
  CodingToolEvent,
  OnMessage,
  RunTurnOpts,
  StartSessionOpts,
  TurnResult,
} from "./adapter.js";

/**
 * Claude CLI adapter.  (498 LOC).
 *
 * Launches `bash -lc` with the configured Claude command, pipes the rendered
 * prompt in via a heredoc, parses stream-json output line-by-line, dispatches
 * events to the orchestrator, and tracks the `session_id` for `--resume` on
 * subsequent turns within the same dispatch.
 */

const ASSISTANT_SUMMARY_LIMIT = 400;
const ERROR_OUTPUT_BYTE_LIMIT = 4_000;
const RECENT_LINES_KEPT = 20;
const MAX_STREAM_LOG_BYTES = 1_000;

interface ClaudeSession extends AdapterSession {
  /**
   * Mutable holder for the Claude CLI session_id reported in the most recent
   * turn — used to pass `--resume <id>` to the next turn so multi-turn dispatch
   * continues in the same conversation thread.
   */
  store: { claudeSessionId: string | null };
}

interface UsageMap {
  [key: string]: number;
}

interface TurnSummary {
  lastText: string;
  cumulativeUsage: UsageMap;
  resultPayload: Record<string, unknown> | null;
  claudeSessionId: string | null;
}

export class ClaudeCliAdapter implements CodingToolAdapter<ClaudeSession> {
  readonly kind = "claude";

  async startSession(
    workspace: string,
    opts: StartSessionOpts = {},
  ): Promise<AdapterResult<ClaudeSession>> {
    const workerHost = opts.workerHost ?? null;
    if (workerHost) {
      return { ok: false, error: { kind: "remote_unsupported" } };
    }

    const validated = await validateWorkspaceCwd(workspace);
    if (!validated.ok) return validated;

    return {
      ok: true,
      value: {
        threadId: uniqueId("claude-thread"),
        workspace: validated.value,
        workerHost: null,
        store: { claudeSessionId: null },
      },
    };
  }

  async runTurn(
    session: ClaudeSession,
    prompt: string,
    issue: Issue,
    opts: RunTurnOpts = {},
  ): Promise<AdapterResult<TurnResult>> {
    const onMessage = opts.onMessage ?? (() => {});
    const turnId = uniqueId("claude-turn");
    const sessionId = `${session.threadId}-${turnId}`;
    const resumeId = session.store.claudeSessionId;

    await emit(onMessage, {
      event: "session_started",
      sessionId,
      threadId: session.threadId,
      turnId,
      resumedClaudeSessionId: resumeId,
      codingTool: "claude",
      timestamp: new Date(),
    });

    const log = logger();
    log.info(
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        session_id: sessionId,
        resume: resumeId ?? "fresh",
      },
      "Claude session started",
    );

    const streamed = await runClaudeStreaming(session.workspace, prompt, onMessage, sessionId, resumeId);
    if (!streamed.ok) {
      await emit(onMessage, {
        event: "turn_failed",
        payload: {
          method: "turn/failed",
          params: { tool: "claude", reason: String(streamed.error) },
        },
        sessionId,
        reason: streamed.error,
        codingTool: "claude",
        timestamp: new Date(),
      });
      log.warn(
        {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: sessionId,
          reason: streamed.error,
        },
        "Claude session ended with error",
      );
      return { ok: false, error: streamed.error };
    }

    const summary = streamed.value;
    if (summary.claudeSessionId) {
      session.store.claudeSessionId = summary.claudeSessionId;
    }

    const outputText = summarizeText(summary.lastText, ERROR_OUTPUT_BYTE_LIMIT);
    await emit(onMessage, {
      event: "turn_completed",
      payload: {
        method: "turn/completed",
        params: { tool: "claude", output: outputText },
      },
      usage: summary.cumulativeUsage,
      sessionId,
      claudeSessionId: summary.claudeSessionId,
      codingTool: "claude",
      timestamp: new Date(),
    });

    log.info(
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        session_id: sessionId,
        claude_session_id: summary.claudeSessionId ?? "n/a",
      },
      "Claude session completed",
    );

    return {
      ok: true,
      value: {
        result: "turn_completed",
        sessionId,
        threadId: session.threadId,
        turnId,
        claudeSessionId: summary.claudeSessionId,
      },
    };
  }

  async stopSession(_session: ClaudeSession): Promise<void> {
    // No-op: the store holder has no resource to release.
  }
}

// ---- streaming engine ----

async function runClaudeStreaming(
  workspace: string,
  prompt: string,
  onMessage: OnMessage,
  sessionId: string,
  resumeId: string | null,
): Promise<AdapterResult<TurnSummary>> {
  const s = await settingsOrThrow();
  const command = appendResumeFlag(s.claude.command, resumeId);
  const script = commandScript(workspace, command, prompt);
  const timeoutMs = s.claude.turn_timeout_ms;

  let summary = initialSummary();
  const recentLines: string[] = [];

  const proc = execa("bash", ["-lc", script], {
    cwd: workspace,
    timeout: timeoutMs,
    reject: false,
    all: true,
    buffer: false,
  });

  const stream = proc.all ?? proc.stdout;
  if (!stream) {
    return { ok: false, error: { kind: "claude_stream_unavailable" } };
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Serialize JSON handling: each line's handler returns a Promise that updates
  // `summary`. We chain them so async work can't interleave usage accumulation.
  let pending: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (line === "") return;
    recentLines.push(line);
    if (recentLines.length > RECENT_LINES_KEPT) recentLines.shift();
    pending = pending.then(async () => {
      summary = await handleLine(line, onMessage, sessionId, summary);
    });
  });

  const result = await proc;
  rl.close();
  await pending;

  if (result.timedOut) {
    return { ok: false, error: { kind: "claude_cli_timeout" } };
  }
  if (result.exitCode !== 0) {
    const tail = recentLines.join("\n");
    return {
      ok: false,
      error: {
        kind: "claude_cli_exit",
        status: result.exitCode ?? -1,
        output: summarizeText(tail, ERROR_OUTPUT_BYTE_LIMIT),
      },
    };
  }
  return { ok: true, value: summary };
}

function initialSummary(): TurnSummary {
  return { lastText: "", cumulativeUsage: {}, resultPayload: null, claudeSessionId: null };
}

async function handleLine(
  line: string,
  onMessage: OnMessage,
  sessionId: string,
  summary: TurnSummary,
): Promise<TurnSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logNonJsonStreamLine(line);
    return summary;
  }
  if (!parsed || typeof parsed !== "object") {
    return summary;
  }
  const payload = parsed as Record<string, unknown>;
  const type = payload.type;
  if (typeof type !== "string") {
    await emit(onMessage, {
      event: "other_message",
      payload,
      sessionId,
      codingTool: "claude",
      timestamp: new Date(),
    });
    return summary;
  }
  return handleClaudeEvent(type, payload, onMessage, sessionId, summary);
}

async function handleClaudeEvent(
  type: string,
  payload: Record<string, unknown>,
  onMessage: OnMessage,
  sessionId: string,
  summary: TurnSummary,
): Promise<TurnSummary> {
  switch (type) {
    case "system": {
      const claudeSessionId = typeof payload.session_id === "string" ? payload.session_id : null;
      await emit(onMessage, {
        event: "system_init",
        payload,
        sessionId,
        claudeSessionId,
        codingTool: "claude",
        timestamp: new Date(),
      });
      return { ...summary, claudeSessionId: claudeSessionId ?? summary.claudeSessionId };
    }
    case "assistant": {
      const message = (payload.message as Record<string, unknown> | undefined) ?? {};
      const messageUsage = (message.usage as Record<string, unknown> | undefined) ?? null;
      const text = assistantText(message) ?? summary.lastText;
      const cumulativeUsage = withTotalTokens(accumulateUsage(summary.cumulativeUsage, messageUsage));
      await emit(onMessage, {
        event: "assistant_message",
        payload,
        sessionId,
        usage: cumulativeUsage,
        messageUsage,
        messageSummary: summarizeText(text, ASSISTANT_SUMMARY_LIMIT),
        codingTool: "claude",
        timestamp: new Date(),
      });
      return { ...summary, lastText: text, cumulativeUsage };
    }
    case "user": {
      await emit(onMessage, {
        event: "tool_result",
        payload,
        sessionId,
        codingTool: "claude",
        timestamp: new Date(),
      });
      return summary;
    }
    case "result": {
      const resultUsage = payload.usage;
      const cumulativeUsage =
        resultUsage && typeof resultUsage === "object"
          ? withTotalTokens({ ...summary.cumulativeUsage, ...(resultUsage as UsageMap) })
          : summary.cumulativeUsage;
      const claudeSessionId =
        typeof payload.session_id === "string" ? payload.session_id : summary.claudeSessionId;
      await emit(onMessage, {
        event: "result",
        payload,
        sessionId,
        usage: cumulativeUsage,
        claudeSessionId,
        codingTool: "claude",
        timestamp: new Date(),
      });
      return { ...summary, resultPayload: payload, cumulativeUsage, claudeSessionId };
    }
    default: {
      await emit(onMessage, {
        event: "other_message",
        payload,
        sessionId,
        codingTool: "claude",
        timestamp: new Date(),
      });
      return summary;
    }
  }
}

// ---- helpers ----

function accumulateUsage(
  cumulative: UsageMap,
  next: Record<string, unknown> | null | undefined,
): UsageMap {
  if (!next || typeof next !== "object") return cumulative;
  const out: UsageMap = { ...cumulative };
  for (const [key, value] of Object.entries(next)) {
    const prev = out[key];
    if (typeof value === "number" && typeof prev === "number") {
      out[key] = prev + value;
    } else if (typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      // mirror Elixir: non-numeric replace
      (out as Record<string, unknown>)[key] = value as unknown as number;
    }
  }
  return out;
}

function withTotalTokens(usage: UsageMap): UsageMap {
  const parts = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]
    .map((k) => usage[k])
    .filter((v): v is number => typeof v === "number");
  const total = parts.reduce((sum, v) => sum + v, 0);
  return { ...usage, total_tokens: total };
}

function assistantText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    }
  }
  return null;
}

function summarizeText(text: string | null | undefined, limit: number): string {
  if (text === null || text === undefined) return "";
  if (typeof text !== "string") return summarizeText(String(text), limit);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return Buffer.from(text, "utf8").subarray(0, limit).toString("utf8") + "...<truncated>";
}

function logNonJsonStreamLine(line: string): void {
  const trimmed = line.trim().slice(0, MAX_STREAM_LOG_BYTES);
  if (trimmed === "") return;
  const isError = /\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(trimmed);
  if (isError) {
    logger().warn({ line: trimmed }, "Claude stream output");
  } else {
    logger().debug({ line: trimmed }, "Claude stream output");
  }
}

function appendResumeFlag(command: string, resumeId: string | null): string {
  if (!resumeId || resumeId === "") return command;
  return `${command} --resume ${shellEscape(resumeId)}`;
}

function commandScript(workspace: string, command: string, prompt: string): string {
  const delimiter = heredocDelimiter(prompt);
  const promptBody = prompt.endsWith("\n") ? prompt : prompt + "\n";
  return (
    `cd ${shellEscape(workspace)}\n` +
    `cat <<'${delimiter}' | ${command}\n` +
    promptBody +
    delimiter
  );
}

function heredocDelimiter(prompt: string): string {
  const base = "__COGNITION_CLAUDE_PROMPT__";
  if (prompt.includes(base)) {
    return `${base}_${uniqueId("END")}`;
  }
  return base;
}

async function validateWorkspaceCwd(workspace: string): Promise<AdapterResult<string>> {
  const s = await settingsOrThrow();
  const expandedWs = path.resolve(workspace);
  const expandedRoot = path.resolve(s.workspace.root);
  const wsCanon = canonicalize(expandedWs);
  const rootCanon = canonicalize(expandedRoot);
  if (!wsCanon.ok) {
    return {
      ok: false,
      error: { kind: "invalid_workspace_cwd", reason: "path_unreadable", path: expandedWs },
    };
  }
  if (!rootCanon.ok) {
    return {
      ok: false,
      error: { kind: "invalid_workspace_cwd", reason: "path_unreadable", path: expandedRoot },
    };
  }
  const canonWs = wsCanon.path;
  const canonRoot = rootCanon.path;
  const canonRootPrefix = canonRoot + path.sep;
  const expandedRootPrefix = expandedRoot + path.sep;
  if (canonWs === canonRoot) {
    return { ok: false, error: { kind: "invalid_workspace_cwd", reason: "workspace_root", path: canonWs } };
  }
  if ((canonWs + path.sep).startsWith(canonRootPrefix)) {
    return { ok: true, value: canonWs };
  }
  if ((expandedWs + path.sep).startsWith(expandedRootPrefix)) {
    return {
      ok: false,
      error: { kind: "invalid_workspace_cwd", reason: "symlink_escape", path: expandedWs },
    };
  }
  return {
    ok: false,
    error: { kind: "invalid_workspace_cwd", reason: "outside_workspace_root", path: canonWs },
  };
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

async function emit(onMessage: OnMessage, event: CodingToolEvent): Promise<void> {
  await onMessage(event);
}
