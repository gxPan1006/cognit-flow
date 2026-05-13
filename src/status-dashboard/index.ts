import type { Orchestrator, OrchestratorSnapshot } from "../orchestrator/index.js";

/**
 * Aggregates orchestrator state for the HTTP/SSE dashboard.
 *
 * The Elixir implementation has two surfaces: a terminal renderer
 * (`status_dashboard.ex`, 1952 LOC) and a Phoenix LiveView web UI
 * (`dashboard_live.ex`, 1193 LOC). The TS port consolidates them into:
 *   - this module: snapshot computation + subscriber broadcast
 *   - `src/http-server`: Hono routes that render HTML + an SSE stream for
 *     real-time updates
 *
 * We do not reproduce the terminal-UI ANSI escape rendering; users get the
 * same information from the web dashboard or the JSON API.
 */

export type DashboardSubscriber = (snapshot: DashboardSnapshot) => void;

export interface DashboardSnapshot {
  generatedAt: string;
  orchestrator: OrchestratorSnapshot;
  metrics: {
    runningCount: number;
    completedCount: number;
    retriesCount: number;
    claimedCount: number;
  };
}

export class StatusDashboard {
  #orchestrator: Orchestrator;
  #subscribers = new Set<DashboardSubscriber>();
  #lastSnapshot: DashboardSnapshot | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #refreshMs: number;

  constructor(orchestrator: Orchestrator, opts: { refreshMs?: number } = {}) {
    this.#orchestrator = orchestrator;
    this.#refreshMs = opts.refreshMs ?? 1_000;
  }

  start(): void {
    if (this.#refreshTimer) return;
    const tick = () => {
      this.broadcastSnapshot();
    };
    this.#refreshTimer = setInterval(tick, this.#refreshMs);
    tick();
  }

  stop(): void {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#subscribers.clear();
  }

  /**
   * Push a fresh snapshot to every subscriber. Called automatically on the
   * refresh timer and on-demand by the orchestrator's onUpdate callback.
   */
  broadcastSnapshot(): void {
    const snapshot = this.snapshot();
    this.#lastSnapshot = snapshot;
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        /* swallow subscriber errors so one bad client doesn't break others */
      }
    }
  }

  snapshot(): DashboardSnapshot {
    const orch = this.#orchestrator.snapshot();
    return {
      generatedAt: new Date().toISOString(),
      orchestrator: orch,
      metrics: {
        runningCount: orch.running.length,
        completedCount: orch.completed.length,
        retriesCount: orch.retries.length,
        claimedCount: orch.claimed.length,
      },
    };
  }

  subscribe(subscriber: DashboardSubscriber): () => void {
    this.#subscribers.add(subscriber);
    if (this.#lastSnapshot) {
      try {
        subscriber(this.#lastSnapshot);
      } catch {
        /* ignore */
      }
    }
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }
}
