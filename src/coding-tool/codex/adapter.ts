import type { Issue } from "../../linear/issue.js";
import type {
  AdapterResult,
  AdapterSession,
  CodingToolAdapter,
  CodingToolEvent,
  RunTurnOpts,
  StartSessionOpts,
  TurnResult,
} from "../adapter.js";
import {
  runTurn as appRunTurn,
  startSession as appStartSession,
  stopSession as appStopSession,
  type CodexSession,
} from "./app-server.js";

interface CodexAdapterSession extends AdapterSession {
  inner: CodexSession;
}

/**
 * Codex adapter implementing the CodingToolAdapter contract on top of the
 * low-level Codex JSON-RPC client.
 */
export class CodexAdapter implements CodingToolAdapter<CodexAdapterSession> {
  readonly kind = "codex";

  async startSession(
    workspace: string,
    opts: StartSessionOpts = {},
  ): Promise<AdapterResult<CodexAdapterSession>> {
    const session = await appStartSession(workspace, { workerHost: opts.workerHost ?? null });
    if (!session.ok) return { ok: false, error: session.error };

    return {
      ok: true,
      value: {
        threadId: session.value.threadId,
        workspace: session.value.workspace,
        workerHost: session.value.workerHost,
        inner: session.value,
      },
    };
  }

  async runTurn(
    session: CodexAdapterSession,
    prompt: string,
    issue: Issue,
    opts: RunTurnOpts = {},
  ): Promise<AdapterResult<TurnResult>> {
    const onMessage = opts.onMessage;
    const turn = await appRunTurn(
      session.inner,
      prompt,
      issue,
      onMessage
        ? {
            onMessage: (codexEvent) =>
              onMessage(codexEventToToolEvent(codexEvent, session.threadId)),
          }
        : {},
    );
    if (!turn.ok) return { ok: false, error: turn.error };
    return {
      ok: true,
      value: {
        result: "turn_completed",
        sessionId: turn.value.sessionId,
        threadId: turn.value.threadId,
        turnId: turn.value.turnId,
        claudeSessionId: null,
      },
    };
  }

  async stopSession(session: CodexAdapterSession): Promise<void> {
    await appStopSession(session.inner);
  }
}

function codexEventToToolEvent(
  codexEvent: {
    event: string;
    payload?: unknown;
    raw?: string | undefined;
    timestamp: Date;
    codingTool: "codex";
    usage?: Record<string, unknown> | undefined;
  },
  threadId: string,
): CodingToolEvent {
  const baseUsage = (codexEvent.usage as Record<string, number> | undefined) ?? {};
  const payload = (codexEvent.payload as Record<string, unknown>) ?? {};
  const sessionIdGuess = `${threadId}-${typeof payload.id === "string" ? payload.id : "n/a"}`;
  const ts = codexEvent.timestamp;
  switch (codexEvent.event) {
    case "session_started":
      return {
        event: "session_started",
        sessionId: (payload.sessionId as string) || sessionIdGuess,
        threadId,
        turnId: (payload.turnId as string) || "",
        codingTool: "codex",
        timestamp: ts,
      };
    case "turn_completed":
      return {
        event: "turn_completed",
        payload,
        usage: baseUsage,
        sessionId: sessionIdGuess,
        codingTool: "codex",
        timestamp: ts,
      };
    case "turn_failed":
    case "turn_cancelled":
      return {
        event: "turn_failed",
        payload,
        sessionId: sessionIdGuess,
        reason: payload.params,
        codingTool: "codex",
        timestamp: ts,
      };
    default:
      return {
        event: "other_message",
        payload,
        raw: (codexEvent.raw as string | undefined) ?? "",
        sessionId: sessionIdGuess,
        codingTool: "codex",
        timestamp: ts,
      };
  }
}
