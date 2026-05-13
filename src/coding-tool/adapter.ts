import type { Issue } from "../linear/issue.js";

/**
 * Coding-tool adapter contract.  behaviour.
 * Each adapter speaks to a different coding tool (Claude CLI, Codex app-server).
 */

export interface AdapterSession {
  readonly threadId: string;
  readonly workspace: string;
  readonly workerHost: string | null;
}

export type CodingToolEvent =
  | {
      event: "session_started";
      sessionId: string;
      threadId: string;
      turnId: string;
      resumedClaudeSessionId?: string | null;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "system_init";
      payload: Record<string, unknown>;
      sessionId: string;
      claudeSessionId: string | null;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "assistant_message";
      payload: Record<string, unknown>;
      sessionId: string;
      usage: Record<string, number>;
      messageUsage: Record<string, unknown> | null;
      messageSummary: string;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "tool_result";
      payload: Record<string, unknown>;
      sessionId: string;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "result";
      payload: Record<string, unknown>;
      sessionId: string;
      usage: Record<string, number>;
      claudeSessionId: string | null;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "other_message";
      payload: Record<string, unknown>;
      raw?: string;
      sessionId: string;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "turn_completed";
      payload: Record<string, unknown>;
      usage: Record<string, number>;
      sessionId: string;
      claudeSessionId?: string | null;
      codingTool: string;
      timestamp: Date;
    }
  | {
      event: "turn_failed";
      payload: Record<string, unknown>;
      sessionId: string;
      reason: unknown;
      codingTool: string;
      timestamp: Date;
    };

export type OnMessage = (event: CodingToolEvent) => void | Promise<void>;

export interface StartSessionOpts {
  workerHost?: string | null | undefined;
}

export interface RunTurnOpts {
  onMessage?: OnMessage;
}

export interface TurnResult {
  result: "turn_completed";
  sessionId: string;
  threadId: string;
  turnId: string;
  claudeSessionId: string | null;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface CodingToolAdapter<S extends AdapterSession = AdapterSession> {
  readonly kind: string;
  startSession(workspace: string, opts?: StartSessionOpts): Promise<AdapterResult<S>>;
  runTurn(session: S, prompt: string, issue: Issue, opts?: RunTurnOpts): Promise<AdapterResult<TurnResult>>;
  stopSession(session: S): Promise<void>;
}
