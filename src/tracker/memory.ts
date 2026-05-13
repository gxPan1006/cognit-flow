import type { LinearAdapter } from "../linear/adapter.js";
import type { LinearResult } from "../linear/client.js";
import type { Issue } from "../linear/issue.js";

/**
 * In-memory tracker adapter for tests and demos. Mirrors
 * the in-memory tracker: holds a list of issues plus an event log of
 * comment/state-change calls.
 */

export interface InMemoryEvent {
  kind: "comment" | "state_update";
  issueId: string;
  body?: string;
  state?: string;
  at: Date;
}

export class InMemoryTracker implements LinearAdapter {
  #issues = new Map<string, Issue>();
  #events: InMemoryEvent[] = [];

  setIssues(issues: Issue[]): void {
    this.#issues = new Map(issues.map((i) => [i.id, i]));
  }

  upsertIssue(issue: Issue): void {
    this.#issues.set(issue.id, issue);
  }

  events(): readonly InMemoryEvent[] {
    return this.#events;
  }

  reset(): void {
    this.#issues.clear();
    this.#events = [];
  }

  async fetchCandidateIssues(): Promise<LinearResult<Issue[]>> {
    return { ok: true, value: Array.from(this.#issues.values()) };
  }

  async fetchIssuesByStates(states: string[]): Promise<LinearResult<Issue[]>> {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    return {
      ok: true,
      value: Array.from(this.#issues.values()).filter((i) => wanted.has(i.state.toLowerCase())),
    };
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<LinearResult<Issue[]>> {
    const out: Issue[] = [];
    for (const id of ids) {
      const issue = this.#issues.get(id);
      if (issue) out.push(issue);
    }
    return { ok: true, value: out };
  }

  async createComment(issueId: string, body: string): Promise<LinearResult<void>> {
    this.#events.push({ kind: "comment", issueId, body, at: new Date() });
    return { ok: true, value: undefined };
  }

  async updateIssueState(issueId: string, stateName: string): Promise<LinearResult<void>> {
    const issue = this.#issues.get(issueId);
    if (issue) {
      this.#issues.set(issueId, { ...issue, state: stateName });
    }
    this.#events.push({ kind: "state_update", issueId, state: stateName, at: new Date() });
    return { ok: true, value: undefined };
  }
}
