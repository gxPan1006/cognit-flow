import { settingsOrThrow } from "../config/index.js";
import { defaultClient } from "../linear/client.js";
import { makeAdapter, type LinearAdapter } from "../linear/adapter.js";
import type { Issue } from "../linear/issue.js";
import type { LinearResult } from "../linear/client.js";
import { InMemoryTracker } from "./memory.js";

/**
 * Adapter boundary for issue tracker reads/writes. 
 * Selects the adapter implementation by `tracker.kind` in WORKFLOW.md.
 *
 * The active adapter can be overridden for tests via `setTrackerAdapter`.
 */

let override: LinearAdapter | null = null;
let processMemory: InMemoryTracker | null = null;

export function setTrackerAdapter(adapter: LinearAdapter | null): void {
  override = adapter;
}

export async function getAdapter(): Promise<LinearAdapter> {
  if (override) return override;
  const s = await settingsOrThrow();
  if (s.tracker.kind === "memory") {
    // Memory tracker: per-process singleton (e.g. for local demo or dev runs
    // where no Linear credentials are wired up). Tests should call
    // setTrackerAdapter() with a fresh InMemoryTracker instead.
    if (!processMemory) processMemory = new InMemoryTracker();
    return processMemory;
  }
  return makeAdapter(defaultClient());
}

export async function fetchCandidateIssues(): Promise<LinearResult<Issue[]>> {
  return (await getAdapter()).fetchCandidateIssues();
}

export async function fetchIssuesByStates(states: string[]): Promise<LinearResult<Issue[]>> {
  return (await getAdapter()).fetchIssuesByStates(states);
}

export async function fetchIssueStatesByIds(ids: string[]): Promise<LinearResult<Issue[]>> {
  return (await getAdapter()).fetchIssueStatesByIds(ids);
}

export async function createComment(
  issueId: string,
  body: string,
): Promise<LinearResult<void>> {
  return (await getAdapter()).createComment(issueId, body);
}

export async function updateIssueState(
  issueId: string,
  stateName: string,
): Promise<LinearResult<void>> {
  return (await getAdapter()).updateIssueState(issueId, stateName);
}
