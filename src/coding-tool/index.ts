import { codingToolKind } from "../config/index.js";
import type { Issue } from "../linear/issue.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import { CodexAdapter } from "./codex/adapter.js";
import type {
  AdapterResult,
  AdapterSession,
  CodingToolAdapter,
  RunTurnOpts,
  StartSessionOpts,
  TurnResult,
} from "./adapter.js";

/**
 * Dispatcher for coding tools.  — picks the
 * adapter implementation by `coding_tool.kind` and threads through start/run/stop.
 */

export interface CodingToolSession {
  readonly kind: string;
  readonly adapter: CodingToolAdapter;
  readonly adapterSession: AdapterSession;
}

export async function startSession(
  workspace: string,
  opts: StartSessionOpts = {},
): Promise<AdapterResult<CodingToolSession>> {
  const kind = await codingToolKind();
  const adapter = adapterFor(kind);

  const session = await adapter.startSession(workspace, opts);
  if (!session.ok) return session;

  return {
    ok: true,
    value: { kind, adapter, adapterSession: session.value },
  };
}

export async function runTurn(
  session: CodingToolSession,
  prompt: string,
  issue: Issue,
  opts: RunTurnOpts = {},
): Promise<AdapterResult<TurnResult>> {
  return session.adapter.runTurn(session.adapterSession, prompt, issue, opts);
}

export async function stopSession(session: CodingToolSession): Promise<void> {
  await session.adapter.stopSession(session.adapterSession);
}

function adapterFor(kind: string): CodingToolAdapter {
  switch (kind) {
    case "claude":
      return new ClaudeCliAdapter();
    case "codex":
    default:
      return new CodexAdapter();
  }
}

export { ClaudeCliAdapter } from "./claude-cli.js";
export { CodexAdapter } from "./codex/adapter.js";
export type {
  AdapterResult,
  AdapterSession,
  CodingToolAdapter,
  CodingToolEvent,
  OnMessage,
  RunTurnOpts,
  StartSessionOpts,
  TurnResult,
} from "./adapter.js";
