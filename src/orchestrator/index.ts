import {
  maxConcurrentAgentsForState,
  settingsOrThrow,
  validateSemantics,
} from "../config/index.js";
import type { Issue } from "../linear/issue.js";
import { logger } from "../log-file.js";
import * as tracker from "../tracker/index.js";
import * as agentRunner from "../agent-runner.js";
import { removeIssueWorkspaces } from "../workspace/index.js";
import type { CodingToolEvent } from "../coding-tool/adapter.js";

/**
 * Polls the configured tracker and dispatches coding-agent runs.
 *  (1662 LOC).
 *
 * Scope: this port covers the core dispatch loop, eligibility checks, retry
 * queue, reconciliation, and snapshot API. Items still pending:
 *   - Codex token / rate-limit aggregation (needs codex adapter, task #10)
 *   - StatusDashboard notification (needs task #11)
 *   - SSH worker-host selection (needs SSH module; defaults to local-only)
 */

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_MS = 10_000;

interface RetryEntry {
  attempt: number;
  identifier: string;
  error?: string | undefined;
  workerHost: string | null;
  workspacePath?: string | null | undefined;
  dueAtMs: number;
  timer: NodeJS.Timeout;
}

interface RunningEntry {
  identifier: string;
  issue: Issue;
  workerHost: string | null;
  workspacePath: string | null;
  startedAt: Date;
  retryAttempt: number;
  abort: AbortController;
  finished: Promise<void>;
  lastCodingToolTimestamp: Date | null;
  lastEvent: string | null;
}

export interface OrchestratorSnapshot {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Array<{
    issueId: string;
    identifier: string;
    state: string;
    startedAt: string;
    workspacePath: string | null;
    lastEvent: string | null;
    lastTimestamp: string | null;
  }>;
  claimed: string[];
  completed: string[];
  retries: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueInMs: number;
    error?: string | undefined;
  }>;
}

export interface OrchestratorOptions {
  /** Called whenever orchestrator state changes — used by the dashboard. */
  onUpdate?: () => void;
}

export class Orchestrator {
  #running = new Map<string, RunningEntry>();
  #claimed = new Set<string>();
  #completed = new Set<string>();
  #retries = new Map<string, RetryEntry>();

  #tickTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #onUpdate: (() => void) | undefined;

  constructor(opts: OrchestratorOptions = {}) {
    this.#onUpdate = opts.onUpdate;
  }

  async start(): Promise<void> {
    if (this.#stopped) throw new Error("orchestrator already stopped");
    await this.#runTerminalWorkspaceCleanup();
    this.#scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    this.#tickTimer = null;
    for (const retry of this.#retries.values()) clearTimeout(retry.timer);
    this.#retries.clear();
    const pending: Promise<void>[] = [];
    for (const entry of this.#running.values()) {
      entry.abort.abort();
      pending.push(entry.finished.catch(() => {}));
    }
    await Promise.all(pending);
    this.#running.clear();
    this.#claimed.clear();
  }

  snapshot(): OrchestratorSnapshot {
    const nowMs = Date.now();
    return {
      pollIntervalMs: 0,
      maxConcurrentAgents: 0,
      running: Array.from(this.#running.entries()).map(([id, entry]) => ({
        issueId: id,
        identifier: entry.identifier,
        state: entry.issue.state,
        startedAt: entry.startedAt.toISOString(),
        workspacePath: entry.workspacePath,
        lastEvent: entry.lastEvent,
        lastTimestamp: entry.lastCodingToolTimestamp?.toISOString() ?? null,
      })),
      claimed: Array.from(this.#claimed),
      completed: Array.from(this.#completed),
      retries: Array.from(this.#retries.entries()).map(([id, r]) => ({
        issueId: id,
        identifier: r.identifier,
        attempt: r.attempt,
        dueInMs: Math.max(0, r.dueAtMs - nowMs),
        error: r.error,
      })),
    };
  }

  // ---- internal scheduling ----

  #scheduleTick(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    this.#tickTimer = setTimeout(() => {
      this.#tickTimer = null;
      void this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#maybeDispatch();
    } catch (err) {
      logger().error({ err }, "Orchestrator tick failed");
    }
    if (this.#stopped) return;
    const settings = await this.#safeSettings();
    const interval = settings?.polling.interval_ms ?? 30_000;
    this.#scheduleTick(interval);
    this.#notifyUpdate();
  }

  async #maybeDispatch(): Promise<void> {
    await this.#reconcileRunningIssues();

    const validation = await validateSemantics();
    if (!validation.ok) {
      logger().error({ error: validation.error }, "Workflow config invalid; skipping dispatch");
      return;
    }

    const candidates = await tracker.fetchCandidateIssues();
    if (!candidates.ok) {
      logger().error({ error: candidates.error }, "Failed to fetch candidate issues");
      return;
    }

    const settings = await settingsOrThrow();
    const maxConcurrent = settings.agent.max_concurrent_agents;
    if (this.#running.size >= maxConcurrent) return;

    const sorted = sortIssuesForDispatch(candidates.value);
    const activeStates = normalizeStateSet(settings.tracker.active_states);
    const terminalStates = normalizeStateSet(settings.tracker.terminal_states);

    for (const issue of sorted) {
      if (this.#running.size >= maxConcurrent) break;
      if (!(await this.#shouldDispatch(issue, activeStates, terminalStates))) continue;
      await this.#dispatchIssue(issue, null);
    }
  }

  async #shouldDispatch(
    issue: Issue,
    activeStates: Set<string>,
    terminalStates: Set<string>,
  ): Promise<boolean> {
    if (!candidateIssue(issue, activeStates, terminalStates)) return false;
    if (todoBlockedByNonTerminal(issue, terminalStates)) return false;
    if (this.#claimed.has(issue.id)) return false;
    if (this.#running.has(issue.id)) return false;

    const perStateLimit = await maxConcurrentAgentsForState(issue.state);
    const usedForState = this.#runningCountForState(issue.state);
    if (usedForState >= perStateLimit) return false;

    return true;
  }

  async #dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    const revalidate = await this.#revalidate(issue);
    if (revalidate.kind === "skip") {
      logger().info({ issue_id: issue.id }, "Skipping dispatch; issue no longer eligible");
      return;
    }
    if (revalidate.kind === "error") {
      logger().warn({ issue_id: issue.id, err: revalidate.error }, "Issue refresh failed");
      return;
    }
    const refreshed = revalidate.issue;

    const abort = new AbortController();
    const startedAt = new Date();
    const entry: RunningEntry = {
      identifier: refreshed.identifier,
      issue: refreshed,
      workerHost: null,
      workspacePath: null,
      startedAt,
      retryAttempt: attempt && attempt > 0 ? attempt : 0,
      abort,
      finished: Promise.resolve(),
      lastCodingToolTimestamp: null,
      lastEvent: null,
    };

    this.#running.set(refreshed.id, entry);
    this.#claimed.add(refreshed.id);
    this.#retries.delete(refreshed.id);

    logger().info(
      {
        issue_id: refreshed.id,
        issue_identifier: refreshed.identifier,
        attempt,
      },
      "Dispatching issue to agent",
    );

    entry.finished = this.#runAgent(refreshed, attempt, entry);
    this.#notifyUpdate();
  }

  async #runAgent(issue: Issue, attempt: number | null, entry: RunningEntry): Promise<void> {
    try {
      const result = await agentRunner.run(issue, {
        attempt,
        workerHost: null,
        onRuntimeInfo: (info) => {
          entry.workspacePath = info.workspacePath;
          entry.workerHost = info.workerHost;
          this.#notifyUpdate();
        },
        onCodingToolEvent: (event: CodingToolEvent) => {
          entry.lastEvent = event.event;
          entry.lastCodingToolTimestamp = event.timestamp;
        },
      });

      if (this.#stopped) return;
      this.#running.delete(issue.id);

      if (result.ok) {
        logger().info(
          { issue_id: issue.id },
          "Agent task completed; scheduling continuation check",
        );
        this.#completed.add(issue.id);
        this.#scheduleRetry(issue.id, {
          attempt: 1,
          identifier: issue.identifier,
          workerHost: entry.workerHost,
          workspacePath: entry.workspacePath,
          delayType: "continuation",
        });
      } else {
        logger().warn(
          { issue_id: issue.id, err: result.error },
          "Agent task failed; scheduling retry",
        );
        const nextAttempt = entry.retryAttempt > 0 ? entry.retryAttempt + 1 : 1;
        this.#scheduleRetry(issue.id, {
          attempt: nextAttempt,
          identifier: issue.identifier,
          error: `agent run failed: ${stringify(result.error)}`,
          workerHost: entry.workerHost,
          workspacePath: entry.workspacePath,
          delayType: "failure",
        });
      }
    } catch (err) {
      if (this.#stopped) return;
      this.#running.delete(issue.id);
      logger().error({ issue_id: issue.id, err }, "Agent runner crashed");
      this.#scheduleRetry(issue.id, {
        attempt: 1,
        identifier: issue.identifier,
        error: `agent run crashed: ${stringify(err)}`,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
        delayType: "failure",
      });
    } finally {
      this.#notifyUpdate();
    }
  }

  #scheduleRetry(
    issueId: string,
    params: {
      attempt: number;
      identifier: string;
      error?: string;
      workerHost: string | null;
      workspacePath?: string | null | undefined;
      delayType: "continuation" | "failure";
    },
  ): void {
    const previous = this.#retries.get(issueId);
    if (previous) clearTimeout(previous.timer);

    void (async () => {
      const delayMs = await this.#computeRetryDelay(params.attempt, params.delayType);
      const dueAtMs = Date.now() + delayMs;
      const timer = setTimeout(() => {
        void this.#handleRetryFire(issueId);
      }, delayMs);

      this.#retries.set(issueId, {
        attempt: params.attempt,
        identifier: params.identifier,
        error: params.error,
        workerHost: params.workerHost,
        workspacePath: params.workspacePath ?? null,
        dueAtMs,
        timer,
      });

      logger().warn(
        {
          issue_id: issueId,
          identifier: params.identifier,
          attempt: params.attempt,
          delayMs,
        },
        "Retrying issue",
      );
    })();
  }

  async #computeRetryDelay(
    attempt: number,
    delayType: "continuation" | "failure",
  ): Promise<number> {
    if (delayType === "continuation" && attempt === 1) return CONTINUATION_RETRY_DELAY_MS;
    const settings = await settingsOrThrow();
    const max = settings.agent.max_retry_backoff_ms;
    const power = Math.min(Math.max(attempt - 1, 0), 10);
    return Math.min(FAILURE_RETRY_BASE_MS * (1 << power), max);
  }

  async #handleRetryFire(issueId: string): Promise<void> {
    const retry = this.#retries.get(issueId);
    if (!retry) return;
    this.#retries.delete(issueId);

    const settings = await this.#safeSettings();
    if (!settings) {
      this.#scheduleRetry(issueId, {
        attempt: retry.attempt + 1,
        identifier: retry.identifier,
        error: "config unavailable",
        workerHost: retry.workerHost,
        delayType: "failure",
      });
      return;
    }

    const fetched = await tracker.fetchCandidateIssues();
    if (!fetched.ok) {
      logger().warn({ issue_id: issueId, err: fetched.error }, "Retry poll failed");
      this.#scheduleRetry(issueId, {
        attempt: retry.attempt + 1,
        identifier: retry.identifier,
        error: `retry poll failed: ${stringify(fetched.error)}`,
        workerHost: retry.workerHost,
        delayType: "failure",
      });
      return;
    }

    const terminalStates = normalizeStateSet(settings.tracker.terminal_states);
    const issue = fetched.value.find((i) => i.id === issueId);
    if (!issue) {
      this.#claimed.delete(issueId);
      return;
    }
    if (terminalStates.has(normalize(issue.state))) {
      logger().info(
        { issue_id: issueId, state: issue.state },
        "Issue terminal; cleaning up workspace",
      );
      await removeIssueWorkspaces(issue.identifier);
      this.#claimed.delete(issueId);
      return;
    }

    await this.#dispatchIssue(issue, retry.attempt);
  }

  async #reconcileRunningIssues(): Promise<void> {
    const runningIds = Array.from(this.#running.keys());
    if (runningIds.length === 0) return;
    const settings = await this.#safeSettings();
    if (!settings) return;

    const fetched = await tracker.fetchIssueStatesByIds(runningIds);
    if (!fetched.ok) {
      logger().debug(
        { err: fetched.error },
        "Failed to refresh running issue states; keeping active workers",
      );
      return;
    }
    const terminalStates = normalizeStateSet(settings.tracker.terminal_states);
    const activeStates = normalizeStateSet(settings.tracker.active_states);
    const visible = new Set(fetched.value.map((i) => i.id));

    for (const issue of fetched.value) {
      const entry = this.#running.get(issue.id);
      if (!entry) continue;
      const norm = normalize(issue.state);
      if (terminalStates.has(norm)) {
        logger().info(
          { issue_id: issue.id, state: issue.state },
          "Issue terminal; stopping active agent",
        );
        entry.abort.abort();
        this.#running.delete(issue.id);
        this.#claimed.delete(issue.id);
        await removeIssueWorkspaces(issue.identifier);
      } else if (!activeStates.has(norm)) {
        logger().info(
          { issue_id: issue.id, state: issue.state },
          "Issue moved out of active states; stopping agent",
        );
        entry.abort.abort();
        this.#running.delete(issue.id);
        this.#claimed.delete(issue.id);
      } else if (!issue.assignedToWorker) {
        logger().info({ issue_id: issue.id }, "Issue no longer assigned to this worker");
        entry.abort.abort();
        this.#running.delete(issue.id);
        this.#claimed.delete(issue.id);
      } else {
        entry.issue = issue;
      }
    }

    for (const runningId of runningIds) {
      if (visible.has(runningId)) continue;
      const entry = this.#running.get(runningId);
      if (!entry) continue;
      logger().info({ issue_id: runningId }, "Issue not visible; stopping agent");
      entry.abort.abort();
      this.#running.delete(runningId);
      this.#claimed.delete(runningId);
    }
  }

  async #runTerminalWorkspaceCleanup(): Promise<void> {
    const settings = await this.#safeSettings();
    if (!settings) return;
    const result = await tracker.fetchIssuesByStates(settings.tracker.terminal_states);
    if (!result.ok) {
      logger().warn(
        { err: result.error },
        "Skipping startup terminal workspace cleanup; failed to fetch terminal issues",
      );
      return;
    }
    for (const issue of result.value) {
      if (typeof issue.identifier === "string") {
        await removeIssueWorkspaces(issue.identifier);
      }
    }
  }

  async #revalidate(
    issue: Issue,
  ): Promise<
    | { kind: "ok"; issue: Issue }
    | { kind: "skip" }
    | { kind: "error"; error: unknown }
  > {
    if (!issue.id) return { kind: "ok", issue };
    const fetched = await tracker.fetchIssueStatesByIds([issue.id]);
    if (!fetched.ok) return { kind: "error", error: fetched.error };
    const next = fetched.value[0];
    if (!next) return { kind: "skip" };

    const settings = await settingsOrThrow();
    const terminalStates = normalizeStateSet(settings.tracker.terminal_states);
    const activeStates = normalizeStateSet(settings.tracker.active_states);
    if (
      candidateIssue(next, activeStates, terminalStates) &&
      !todoBlockedByNonTerminal(next, terminalStates)
    ) {
      return { kind: "ok", issue: next };
    }
    return { kind: "skip" };
  }

  #runningCountForState(state: string): number {
    const normalized = normalize(state);
    let count = 0;
    for (const entry of this.#running.values()) {
      if (normalize(entry.issue.state) === normalized) count++;
    }
    return count;
  }

  async #safeSettings() {
    try {
      return await settingsOrThrow();
    } catch (err) {
      logger().error({ err }, "Failed to read settings");
      return null;
    }
  }

  #notifyUpdate(): void {
    try {
      this.#onUpdate?.();
    } catch (err) {
      logger().debug({ err }, "Orchestrator update callback failed");
    }
  }
}

// ---- eligibility helpers (exported for testing) ----

export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = priorityRank(a.priority);
    const pb = priorityRank(b.priority);
    if (pa !== pb) return pa - pb;
    const ca = a.createdAt ? a.createdAt.getTime() : Number.MAX_SAFE_INTEGER;
    const cb = b.createdAt ? b.createdAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return (a.identifier || a.id || "").localeCompare(b.identifier || b.id || "");
  });
}

export function candidateIssue(
  issue: Issue,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
  if (!issue.assignedToWorker) return false;
  const norm = normalize(issue.state);
  if (terminalStates.has(norm)) return false;
  return activeStates.has(norm);
}

export function todoBlockedByNonTerminal(
  issue: Issue,
  terminalStates: Set<string>,
): boolean {
  if (normalize(issue.state) !== "todo") return false;
  return issue.blockedBy.some((blocker) => {
    if (typeof blocker.state !== "string") return true;
    return !terminalStates.has(normalize(blocker.state));
  });
}

function normalizeStateSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalize).filter((s) => s !== ""));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function priorityRank(priority: number | null): number {
  if (typeof priority === "number" && priority >= 1 && priority <= 4) return priority;
  return 5;
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

