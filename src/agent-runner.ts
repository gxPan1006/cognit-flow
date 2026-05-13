import * as runtime from "./coding-tool/index.js";
import { settingsOrThrow } from "./config/index.js";
import type { Issue } from "./linear/issue.js";
import { logger } from "./log-file.js";
import { buildPrompt } from "./prompt-builder.js";
import * as tracker from "./tracker/index.js";
import type { CodingToolEvent, OnMessage } from "./coding-tool/adapter.js";
import {
  createForIssue,
  runAfterRunHook,
  runBeforeRunHook,
} from "./workspace/index.js";

/**
 * Runs a single Linear issue end-to-end inside its workspace. Mirrors
 *
 * Lifecycle:
 *   1. Create the workspace (with after_create hook).
 *   2. Notify the orchestrator of the resolved workspace + host.
 *   3. Run the configured before_run hook; abort on failure.
 *   4. Start a coding-tool session and run turns up to `agent.max_turns`,
 *      checking after each turn whether the issue is still active.
 *   5. Always run after_run hook on exit (failures logged but ignored).
 */

export interface RunOpts {
  attempt?: number | null;
  workerHost?: string | null;
  maxTurns?: number;
  /** Called with each coding-tool event so the orchestrator can update its UI. */
  onCodingToolEvent?: OnMessage;
  /** Called once with the resolved workspace path + worker host. */
  onRuntimeInfo?: (info: RuntimeInfo) => void;
  /** Optional issue-state fetcher; used to decide whether to continue after a turn. */
  issueStateFetcher?: (ids: string[]) => Promise<{ ok: true; value: Issue[] } | { ok: false; error: unknown }>;
}

export interface RuntimeInfo {
  workerHost: string | null;
  workspacePath: string;
}

export type AgentRunResult =
  | { ok: true }
  | { ok: false; error: unknown };

export async function run(issue: Issue, opts: RunOpts = {}): Promise<AgentRunResult> {
  const workerHost = opts.workerHost ?? null;
  const log = logger();
  log.info(
    {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      worker_host: workerHost ?? "local",
    },
    "Starting agent run",
  );

  const created = await createForIssue(issue, workerHost);
  if (!created.ok) {
    return { ok: false, error: created.error };
  }
  const workspace = created.value;
  opts.onRuntimeInfo?.({ workerHost, workspacePath: workspace });

  try {
    const beforeRun = await runBeforeRunHook(workspace, issue);
    if (!beforeRun.ok) return { ok: false, error: beforeRun.error };

    return await runCodingToolTurns(workspace, issue, opts);
  } finally {
    await runAfterRunHook(workspace, issue);
  }
}

async function runCodingToolTurns(
  workspace: string,
  issue: Issue,
  opts: RunOpts,
): Promise<AgentRunResult> {
  const settings = await settingsOrThrow();
  const maxTurns = opts.maxTurns ?? settings.agent.max_turns;
  const issueStateFetcher = opts.issueStateFetcher ?? tracker.fetchIssueStatesByIds;

  const session = await runtime.startSession(workspace, { workerHost: opts.workerHost });
  if (!session.ok) {
    return { ok: false, error: session.error };
  }

  try {
    let currentIssue = issue;
    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
      const prompt =
        turnNumber === 1
          ? await buildPrompt(currentIssue, { attempt: opts.attempt ?? null })
          : continuationPrompt(turnNumber, maxTurns);

      const turn = await runtime.runTurn(session.value, prompt, currentIssue, {
        onMessage: opts.onCodingToolEvent ?? (() => {}),
      });
      if (!turn.ok) {
        return { ok: false, error: turn.error };
      }

      logger().info(
        {
          issue_id: currentIssue.id,
          issue_identifier: currentIssue.identifier,
          session_id: turn.value.sessionId,
          workspace,
          turn: `${turnNumber}/${maxTurns}`,
        },
        "Completed agent turn",
      );

      const decision = await continueWithIssue(currentIssue, issueStateFetcher);
      if (decision.kind === "error") return { ok: false, error: decision.error };
      if (decision.kind === "done") return { ok: true };
      if (turnNumber === maxTurns) {
        logger().info(
          { issue_identifier: currentIssue.identifier },
          "Reached agent.max_turns with issue still active; returning control to orchestrator",
        );
        return { ok: true };
      }
      currentIssue = decision.issue;
    }
    return { ok: true };
  } finally {
    await runtime.stopSession(session.value);
  }
}

type ContinueDecision =
  | { kind: "continue"; issue: Issue }
  | { kind: "done" }
  | { kind: "error"; error: unknown };

async function continueWithIssue(
  issue: Issue,
  fetcher: (ids: string[]) => Promise<{ ok: true; value: Issue[] } | { ok: false; error: unknown }>,
): Promise<ContinueDecision> {
  if (!issue.id) return { kind: "done" };
  const refreshed = await fetcher([issue.id]);
  if (!refreshed.ok) return { kind: "error", error: { kind: "issue_state_refresh_failed", cause: refreshed.error } };
  const next = refreshed.value[0];
  if (!next) return { kind: "done" };
  return (await isActiveState(next.state)) ? { kind: "continue", issue: next } : { kind: "done" };
}

async function isActiveState(stateName: string): Promise<boolean> {
  const settings = await settingsOrThrow();
  const normalized = normalize(stateName);
  return settings.tracker.active_states.some((s) => normalize(s) === normalized);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function continuationPrompt(turnNumber: number, maxTurns: number): string {
  return [
    "Continuation guidance:",
    "",
    "- The previous coding-tool turn completed normally, but the Linear issue is still in an active state.",
    `- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.`,
    "- Resume from the current workspace and workpad state instead of restarting from scratch.",
    "- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.",
    "- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.",
  ].join("\n");
}

export type { CodingToolEvent };
