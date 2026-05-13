import * as readline from "node:readline";
import * as path from "node:path";
import { execa, type ExecaError } from "execa";
import { codexTurnSandboxPolicy, settingsOrThrow } from "../../config/index.js";
import { canonicalize } from "../../path-safety.js";
import { logger } from "../../log-file.js";
import type { Issue } from "../../linear/issue.js";
import { defaultDynamicTool, type DynamicToolExecutor, type DynamicToolResult } from "./dynamic-tool.js";

/**
 * Minimal Codex app-server JSON-RPC client over stdio.
 *  (1096 LOC) — initialize → thread/start →
 * turn/start → receive_loop with approval auto-accept and dynamic tool calls.
 */

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;
const NON_INTERACTIVE_INPUT_ANSWER =
  "This is a non-interactive session. Operator input is unavailable.";

export interface CodexEventBase {
  event: string;
  payload?: unknown;
  raw?: string | undefined;
  timestamp: Date;
  codingTool: "codex";
  codexAppServerPid?: string | undefined;
  usage?: Record<string, unknown> | undefined;
}

export type OnCodexMessage = (event: CodexEventBase) => void | Promise<void>;

export interface CodexSession {
  proc: ReturnType<typeof execa> & { stdin?: NodeJS.WritableStream | null; stdout?: NodeJS.ReadableStream | null; pid?: number | undefined; kill?: (signal?: NodeJS.Signals) => void };
  rl: readline.Interface;
  threadId: string;
  workspace: string;
  approvalPolicy: string | Record<string, unknown>;
  autoApprove: boolean;
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown>;
  pid: string | null;
  workerHost: string | null;
  /** Lines we've consumed from stdout, queued for await/receive. */
  inbox: string[];
  /** Resolved when a new line arrives in inbox. */
  waiter: { resolve: () => void } | null;
  /** True once the child process has exited. */
  exited: boolean;
  exitStatus: number | null;
}

export interface StartSessionOpts {
  workerHost?: string | null;
}

export interface RunTurnOpts {
  onMessage?: OnCodexMessage;
  toolExecutor?: DynamicToolExecutor;
}

export type CodexResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface TurnSuccess {
  result: "turn_completed";
  threadId: string;
  turnId: string;
  sessionId: string;
}

export async function startSession(
  workspace: string,
  opts: StartSessionOpts = {},
): Promise<CodexResult<CodexSession>> {
  const workerHost = opts.workerHost ?? null;
  if (workerHost) {
    return { ok: false, error: { kind: "remote_unsupported" } };
  }

  const validated = await validateWorkspace(workspace);
  if (!validated.ok) return validated;

  const settings = await settingsOrThrow();
  const turnSandboxPolicy = await codexTurnSandboxPolicy(validated.value);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc: any = execa("bash", ["-lc", settings.codex.command], {
    cwd: validated.value,
    reject: false,
    all: false,
    buffer: false,
  });

  const stdout = proc.stdout;
  if (!stdout) {
    return { ok: false, error: { kind: "codex_stdout_unavailable" } };
  }

  const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
  const session: CodexSession = {
    proc,
    rl,
    threadId: "",
    workspace: validated.value,
    approvalPolicy: settings.codex.approval_policy,
    autoApprove: settings.codex.approval_policy === "never",
    threadSandbox: settings.codex.thread_sandbox,
    turnSandboxPolicy,
    pid: proc.pid ? String(proc.pid) : null,
    workerHost: null,
    inbox: [],
    waiter: null,
    exited: false,
    exitStatus: null,
  };

  rl.on("line", (line) => {
    session.inbox.push(line);
    const w = session.waiter;
    session.waiter = null;
    if (w) w.resolve();
  });
  void proc.then(
    (result: { exitCode?: number | null }) => {
      session.exited = true;
      session.exitStatus = result.exitCode ?? -1;
      const w = session.waiter;
      session.waiter = null;
      if (w) w.resolve();
    },
    (err: ExecaError) => {
      session.exited = true;
      session.exitStatus = err.exitCode ?? -1;
      const w = session.waiter;
      session.waiter = null;
      if (w) w.resolve();
    },
  );

  // --- initialize handshake ---
  const initResult = await sendInitialize(session);
  if (!initResult.ok) {
    await stopSession(session);
    return initResult;
  }

  // --- thread/start ---
  const dynamicTool = defaultDynamicTool();
  const threadResult = await sendThreadStart(session, dynamicTool);
  if (!threadResult.ok) {
    await stopSession(session);
    return threadResult;
  }
  session.threadId = threadResult.value;

  return { ok: true, value: session };
}

export async function runTurn(
  session: CodexSession,
  prompt: string,
  issue: Issue,
  opts: RunTurnOpts = {},
): Promise<CodexResult<TurnSuccess>> {
  const onMessage = opts.onMessage ?? (() => {});
  const toolExecutor = opts.toolExecutor ?? defaultDynamicTool();

  const turnStart = await sendTurnStart(session, prompt, issue);
  if (!turnStart.ok) {
    await emit(onMessage, { event: "startup_failed", payload: turnStart.error }, session);
    return turnStart;
  }

  const turnId = turnStart.value;
  const sessionId = `${session.threadId}-${turnId}`;
  logger().info(
    { issue_id: issue.id, session_id: sessionId },
    "Codex session started",
  );
  await emit(
    onMessage,
    {
      event: "session_started",
      payload: { sessionId, threadId: session.threadId, turnId },
    },
    session,
  );

  const result = await receiveLoop(session, onMessage, toolExecutor);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: { result: "turn_completed", threadId: session.threadId, turnId, sessionId },
  };
}

export async function stopSession(session: CodexSession): Promise<void> {
  try {
    session.rl.close();
  } catch {
    /* ignore */
  }
  if (!session.exited && session.proc.pid) {
    try {
      session.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  try {
    await session.proc;
  } catch {
    /* ignore */
  }
}

// ---- protocol helpers ----

async function sendInitialize(session: CodexSession): Promise<CodexResult<void>> {
  sendMessage(session, {
    method: "initialize",
    id: INITIALIZE_ID,
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "cognit-flow",
        title: "Cognit Flow",
        version: "0.1.0",
      },
    },
  });
  const response = await awaitResponse(session, INITIALIZE_ID);
  if (!response.ok) return response;
  sendMessage(session, { method: "initialized", params: {} });
  return { ok: true, value: undefined };
}

async function sendThreadStart(
  session: CodexSession,
  dynamicTool: DynamicToolExecutor,
): Promise<CodexResult<string>> {
  sendMessage(session, {
    method: "thread/start",
    id: THREAD_START_ID,
    params: {
      approvalPolicy: session.approvalPolicy,
      sandbox: session.threadSandbox,
      cwd: session.workspace,
      dynamicTools: dynamicTool.toolSpecs(),
    },
  });
  const response = await awaitResponse(session, THREAD_START_ID);
  if (!response.ok) return response;
  const threadPayload = (response.value as { thread?: { id?: string } } | undefined)?.thread;
  if (!threadPayload || typeof threadPayload.id !== "string") {
    return { ok: false, error: { kind: "invalid_thread_payload", payload: response.value } };
  }
  return { ok: true, value: threadPayload.id };
}

async function sendTurnStart(
  session: CodexSession,
  prompt: string,
  issue: Issue,
): Promise<CodexResult<string>> {
  sendMessage(session, {
    method: "turn/start",
    id: TURN_START_ID,
    params: {
      threadId: session.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: session.workspace,
      title: `${issue.identifier}: ${issue.title}`,
      approvalPolicy: session.approvalPolicy,
      sandboxPolicy: session.turnSandboxPolicy,
    },
  });
  const response = await awaitResponse(session, TURN_START_ID);
  if (!response.ok) return response;
  const turn = (response.value as { turn?: { id?: string } } | undefined)?.turn;
  if (!turn || typeof turn.id !== "string") {
    return { ok: false, error: { kind: "invalid_turn_payload", payload: response.value } };
  }
  return { ok: true, value: turn.id };
}

async function awaitResponse(
  session: CodexSession,
  requestId: number,
): Promise<CodexResult<unknown>> {
  const settings = await settingsOrThrow();
  const timeoutMs = settings.codex.read_timeout_ms;

  while (true) {
    const line = await readLine(session, timeoutMs);
    if (!line.ok) return line;
    const text = line.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logNonJsonStreamLine(text, "response stream");
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.id === requestId) {
      if ("error" in rec) {
        return { ok: false, error: { kind: "response_error", error: rec.error } };
      }
      if ("result" in rec) return { ok: true, value: rec.result };
      return { ok: false, error: { kind: "response_error", payload: rec } };
    }
    // Ignore unrelated message and keep waiting for our id.
  }
}

async function receiveLoop(
  session: CodexSession,
  onMessage: OnCodexMessage,
  toolExecutor: DynamicToolExecutor,
): Promise<CodexResult<"turn_completed">> {
  const settings = await settingsOrThrow();
  const turnTimeoutMs = settings.codex.turn_timeout_ms;

  while (true) {
    const line = await readLine(session, turnTimeoutMs);
    if (!line.ok) return line as CodexResult<"turn_completed">;
    const text = line.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logNonJsonStreamLine(text, "turn stream");
      if (text.trimStart().startsWith("{")) {
        await emit(onMessage, { event: "malformed", payload: text, raw: text }, session);
      }
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const payload = parsed as Record<string, unknown>;
    const method = typeof payload.method === "string" ? payload.method : null;

    if (method === "turn/completed") {
      await emit(onMessage, { event: "turn_completed", payload, raw: text }, session);
      return { ok: true, value: "turn_completed" };
    }
    if (method === "turn/failed") {
      await emit(onMessage, { event: "turn_failed", payload, raw: text }, session);
      return { ok: false, error: { kind: "turn_failed", params: payload.params } };
    }
    if (method === "turn/cancelled") {
      await emit(onMessage, { event: "turn_cancelled", payload, raw: text }, session);
      return { ok: false, error: { kind: "turn_cancelled", params: payload.params } };
    }

    if (method) {
      const handled = await handleTurnMethod(session, method, payload, text, onMessage, toolExecutor);
      if (handled.kind === "abort") {
        return { ok: false, error: handled.error };
      }
      continue;
    }

    await emit(onMessage, { event: "other_message", payload, raw: text }, session);
  }
}

type HandledMethod = { kind: "continue" } | { kind: "abort"; error: unknown };

async function handleTurnMethod(
  session: CodexSession,
  method: string,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: OnCodexMessage,
  toolExecutor: DynamicToolExecutor,
): Promise<HandledMethod> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return approveOrRequire(session, payload, raw, "acceptForSession", onMessage);
    case "execCommandApproval":
    case "applyPatchApproval":
      return approveOrRequire(session, payload, raw, "approved_for_session", onMessage);
    case "item/tool/call":
      return handleToolCall(session, payload, raw, onMessage, toolExecutor);
    case "item/tool/requestUserInput":
      return handleRequestUserInput(session, payload, raw, onMessage);
    default:
      if (needsInput(method, payload)) {
        await emit(onMessage, { event: "turn_input_required", payload, raw }, session);
        return { kind: "abort", error: { kind: "turn_input_required", payload } };
      }
      await emit(onMessage, { event: "notification", payload, raw }, session);
      return { kind: "continue" };
  }
}

async function approveOrRequire(
  session: CodexSession,
  payload: Record<string, unknown>,
  raw: string,
  decision: string,
  onMessage: OnCodexMessage,
): Promise<HandledMethod> {
  const id = payload.id;
  if (!session.autoApprove) {
    await emit(onMessage, { event: "approval_required", payload, raw }, session);
    return { kind: "abort", error: { kind: "approval_required", payload } };
  }
  sendMessage(session, { id, result: { decision } });
  await emit(onMessage, { event: "approval_auto_approved", payload, raw }, session);
  return { kind: "continue" };
}

async function handleToolCall(
  session: CodexSession,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: OnCodexMessage,
  toolExecutor: DynamicToolExecutor,
): Promise<HandledMethod> {
  const id = payload.id;
  const params = (payload.params ?? {}) as Record<string, unknown>;
  const toolName = pickToolName(params);
  const args = params.arguments ?? {};

  const rawResult = toolName ? await toolExecutor.execute(toolName, args) : null;
  const result: DynamicToolResult = rawResult ?? {
    success: false,
    output: JSON.stringify({ error: { message: "Unsupported tool call." } }, null, 2),
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ error: { message: "Unsupported tool call." } }, null, 2),
      },
    ],
  };

  sendMessage(session, { id, result });

  const event = !toolName
    ? "unsupported_tool_call"
    : result.success
      ? "tool_call_completed"
      : "tool_call_failed";
  await emit(onMessage, { event, payload, raw }, session);
  return { kind: "continue" };
}

async function handleRequestUserInput(
  session: CodexSession,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: OnCodexMessage,
): Promise<HandledMethod> {
  const id = payload.id;
  const params = (payload.params ?? {}) as Record<string, unknown>;

  if (session.autoApprove) {
    const approvalAnswers = pickApprovalAnswers(params);
    if (approvalAnswers) {
      sendMessage(session, { id, result: { answers: approvalAnswers.answers } });
      await emit(onMessage, { event: "approval_auto_approved", payload, raw }, session);
      return { kind: "continue" };
    }
  }

  const nonInteractive = pickNonInteractiveAnswers(params);
  if (nonInteractive) {
    sendMessage(session, { id, result: { answers: nonInteractive } });
    await emit(onMessage, { event: "tool_input_auto_answered", payload, raw }, session);
    return { kind: "continue" };
  }

  await emit(onMessage, { event: "turn_input_required", payload, raw }, session);
  return { kind: "abort", error: { kind: "turn_input_required", payload } };
}

function pickApprovalAnswers(
  params: Record<string, unknown>,
): { answers: Record<string, { answers: string[] }>; decision: string } | null {
  const questions = params.questions;
  if (!Array.isArray(questions)) return null;
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    if (!q || typeof q !== "object") return null;
    const rec = q as Record<string, unknown>;
    const qid = rec.id;
    const options = rec.options;
    if (typeof qid !== "string" || !Array.isArray(options)) return null;
    const label = pickApprovalOptionLabel(options);
    if (!label) return null;
    answers[qid] = { answers: [label] };
  }
  return Object.keys(answers).length > 0
    ? { answers, decision: "Approve this Session" }
    : null;
}

function pickApprovalOptionLabel(options: unknown[]): string | null {
  const labels: string[] = [];
  for (const o of options) {
    if (o && typeof o === "object") {
      const lbl = (o as Record<string, unknown>).label;
      if (typeof lbl === "string") labels.push(lbl);
    }
  }
  return (
    labels.find((l) => l === "Approve this Session") ??
    labels.find((l) => l === "Approve Once") ??
    labels.find((l) => {
      const norm = l.trim().toLowerCase();
      return norm.startsWith("approve") || norm.startsWith("allow");
    }) ??
    null
  );
}

function pickNonInteractiveAnswers(
  params: Record<string, unknown>,
): Record<string, { answers: string[] }> | null {
  const questions = params.questions;
  if (!Array.isArray(questions)) return null;
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    if (!q || typeof q !== "object") return null;
    const qid = (q as Record<string, unknown>).id;
    if (typeof qid !== "string") return null;
    answers[qid] = { answers: [NON_INTERACTIVE_INPUT_ANSWER] };
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function pickToolName(params: Record<string, unknown>): string | null {
  const value = (params.tool as unknown) ?? (params.name as unknown);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function needsInput(method: string, payload: Record<string, unknown>): boolean {
  if (!method.startsWith("turn/")) return false;
  if (
    [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required",
    ].includes(method)
  ) {
    return true;
  }
  return inputRequiredField(payload) || inputRequiredField(payload.params);
}

function inputRequiredField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.requiresInput === true ||
    r.needsInput === true ||
    r.input_required === true ||
    r.inputRequired === true ||
    r.type === "input_required" ||
    r.type === "needs_input"
  );
}

// ---- I/O primitives ----

async function readLine(
  session: CodexSession,
  timeoutMs: number,
): Promise<CodexResult<string>> {
  return new Promise((resolve) => {
    const tryTake = () => {
      if (session.inbox.length > 0) {
        const value = session.inbox.shift()!;
        resolve({ ok: true, value });
        return true;
      }
      if (session.exited) {
        resolve({ ok: false, error: { kind: "port_exit", status: session.exitStatus } });
        return true;
      }
      return false;
    };
    if (tryTake()) return;

    const timeout = setTimeout(() => {
      session.waiter = null;
      resolve({ ok: false, error: { kind: "response_timeout" } });
    }, timeoutMs);

    session.waiter = {
      resolve: () => {
        clearTimeout(timeout);
        if (!tryTake()) {
          // Spurious wakeup; re-arm.
          session.waiter = null;
          setImmediate(() => {
            void readLine(session, timeoutMs).then(resolve);
          });
        }
      },
    };
  });
}

function sendMessage(session: CodexSession, message: Record<string, unknown>): void {
  const stdin = session.proc.stdin;
  if (!stdin || stdin.destroyed) return;
  stdin.write(JSON.stringify(message) + "\n");
}

async function emit(
  onMessage: OnCodexMessage,
  details: Partial<CodexEventBase> & { event: string },
  session: CodexSession,
): Promise<void> {
  const usage =
    details.payload && typeof details.payload === "object" && details.payload !== null
      ? ((details.payload as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined;
  await onMessage({
    event: details.event,
    payload: details.payload,
    raw: details.raw,
    timestamp: new Date(),
    codingTool: "codex",
    codexAppServerPid: session.pid ?? undefined,
    usage,
  });
}

async function validateWorkspace(workspace: string): Promise<CodexResult<string>> {
  const s = await settingsOrThrow();
  const expandedWs = path.resolve(workspace);
  const expandedRoot = path.resolve(s.workspace.root);
  const wsCanon = canonicalize(expandedWs);
  const rootCanon = canonicalize(expandedRoot);
  if (!wsCanon.ok) {
    return { ok: false, error: { kind: "invalid_workspace_cwd", reason: "path_unreadable", path: expandedWs } };
  }
  if (!rootCanon.ok) {
    return { ok: false, error: { kind: "invalid_workspace_cwd", reason: "path_unreadable", path: expandedRoot } };
  }
  const canonWs = wsCanon.path;
  const canonRoot = rootCanon.path;
  const canonRootPrefix = canonRoot + path.sep;
  const expandedRootPrefix = expandedRoot + path.sep;
  if (canonWs === canonRoot) {
    return { ok: false, error: { kind: "invalid_workspace_cwd", reason: "workspace_root", path: canonWs } };
  }
  if ((canonWs + path.sep).startsWith(canonRootPrefix)) return { ok: true, value: canonWs };
  if ((expandedWs + path.sep).startsWith(expandedRootPrefix)) {
    return { ok: false, error: { kind: "invalid_workspace_cwd", reason: "symlink_escape", path: expandedWs } };
  }
  return {
    ok: false,
    error: { kind: "invalid_workspace_cwd", reason: "outside_workspace_root", path: canonWs },
  };
}

function logNonJsonStreamLine(line: string, label: string): void {
  const trimmed = line.trim().slice(0, 1000);
  if (trimmed === "") return;
  const isError = /\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(trimmed);
  if (isError) {
    logger().warn({ stream: label, line: trimmed }, "Codex non-JSON output");
  } else {
    logger().debug({ stream: label, line: trimmed }, "Codex non-JSON output");
  }
}
