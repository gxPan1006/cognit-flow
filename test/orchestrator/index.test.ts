import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  candidateIssue,
  Orchestrator,
  sortIssuesForDispatch,
  todoBlockedByNonTerminal,
} from "../../src/orchestrator/index.js";
import { makeIssue } from "../../src/linear/issue.js";
import { setTrackerAdapter } from "../../src/tracker/index.js";
import { InMemoryTracker } from "../../src/tracker/memory.js";
import { workflowStore } from "../../src/workflow/store.js";

describe("orchestrator eligibility helpers", () => {
  const active = new Set(["todo", "in progress"]);
  const terminal = new Set(["done", "cancelled"]);

  it("rejects issues with missing required fields", () => {
    const issue = makeIssue({ id: "", identifier: "", title: "", state: "" });
    expect(candidateIssue(issue, active, terminal)).toBe(false);
  });

  it("accepts active issues with all required fields", () => {
    const issue = makeIssue({ id: "1", identifier: "A-1", title: "T", state: "Todo" });
    expect(candidateIssue(issue, active, terminal)).toBe(true);
  });

  it("rejects terminal issues", () => {
    const issue = makeIssue({ id: "1", identifier: "A-1", title: "T", state: "Done" });
    expect(candidateIssue(issue, active, terminal)).toBe(false);
  });

  it("rejects issues not assigned to this worker", () => {
    const issue = makeIssue({
      id: "1",
      identifier: "A-1",
      title: "T",
      state: "Todo",
      assignedToWorker: false,
    });
    expect(candidateIssue(issue, active, terminal)).toBe(false);
  });

  it("marks todo issues with non-terminal blockers as blocked", () => {
    const issue = makeIssue({
      id: "1",
      identifier: "A-1",
      title: "T",
      state: "Todo",
      blockedBy: [{ id: "b1", identifier: "A-99", state: "In Progress" }],
    });
    expect(todoBlockedByNonTerminal(issue, terminal)).toBe(true);
  });

  it("does not mark todo issues as blocked when blocker is terminal", () => {
    const issue = makeIssue({
      id: "1",
      identifier: "A-1",
      title: "T",
      state: "Todo",
      blockedBy: [{ id: "b1", identifier: "A-99", state: "Done" }],
    });
    expect(todoBlockedByNonTerminal(issue, terminal)).toBe(false);
  });

  it("sorts issues by priority then creation time then identifier", () => {
    const issues = [
      makeIssue({ id: "3", identifier: "A-3", title: "T", state: "Todo", priority: 4 }),
      makeIssue({
        id: "1",
        identifier: "A-1",
        title: "T",
        state: "Todo",
        priority: 1,
        createdAt: new Date("2024-01-01"),
      }),
      makeIssue({
        id: "2",
        identifier: "A-2",
        title: "T",
        state: "Todo",
        priority: 1,
        createdAt: new Date("2024-02-01"),
      }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["A-1", "A-2", "A-3"]);
  });
});

describe("Orchestrator end-to-end (in-memory tracker, fake agent runner)", () => {
  let root: string;
  let memory: InMemoryTracker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-orch-test-"));
    memory = new InMemoryTracker();
    setTrackerAdapter(memory);

    workflowStore.set({
      config: {
        tracker: { kind: "memory", project_slug: "TEST" },
        polling: { interval_ms: 50 },
        workspace: { root },
        coding_tool: { kind: "claude" },
        claude: {
          // No-op stream that emits a single result so AgentRunner finishes quickly.
          command: "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"x\"}'",
          turn_timeout_ms: 5_000,
          stall_timeout_ms: 5_000,
        },
        agent: { max_concurrent_agents: 2, max_turns: 1, max_retry_backoff_ms: 60_000 },
        hooks: { timeout_ms: 5_000 },
      },
      prompt: "Hello {{ issue.identifier }}",
      promptTemplate: "Hello {{ issue.identifier }}",
    });
  });

  afterEach(async () => {
    setTrackerAdapter(null);
    workflowStore.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("dispatches active candidate issues up to the concurrency limit", async () => {
    memory.setIssues([
      makeIssue({ id: "i1", identifier: "ORC-1", title: "First", state: "Todo" }),
      makeIssue({ id: "i2", identifier: "ORC-2", title: "Second", state: "Todo" }),
      makeIssue({ id: "i3", identifier: "ORC-3", title: "Third", state: "Todo" }),
    ]);

    const orchestrator = new Orchestrator();
    await orchestrator.start();

    // After the first tick, we expect dispatches to be initiated. Wait briefly
    // for the agent runs (which use our fake claude command) to finish.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const snap = orchestrator.snapshot();
    // Once the runs finish, completed should contain at least one of the dispatched issues.
    expect(snap.completed.length + snap.running.length + snap.retries.length).toBeGreaterThan(0);
    await orchestrator.stop();
  });

  it("skips issues that have already moved to a terminal state", async () => {
    memory.setIssues([
      makeIssue({ id: "i1", identifier: "DONE-1", title: "Already done", state: "Done" }),
    ]);

    const orchestrator = new Orchestrator();
    await orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const snap = orchestrator.snapshot();
    expect(snap.running).toHaveLength(0);
    expect(snap.completed).toHaveLength(0);
    await orchestrator.stop();
  });

  it("returns a snapshot listing running, claimed, completed, and retries", async () => {
    memory.setIssues([
      makeIssue({ id: "i1", identifier: "SNAP-1", title: "T", state: "Todo" }),
    ]);
    const orchestrator = new Orchestrator();
    await orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const snap = orchestrator.snapshot();
    expect(Array.isArray(snap.running)).toBe(true);
    expect(Array.isArray(snap.claimed)).toBe(true);
    expect(Array.isArray(snap.completed)).toBe(true);
    expect(Array.isArray(snap.retries)).toBe(true);
    await orchestrator.stop();
  });
});
