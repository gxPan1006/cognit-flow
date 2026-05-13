import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/index.js";
import { StatusDashboard } from "../src/status-dashboard/index.js";

describe("StatusDashboard", () => {
  it("delivers the current snapshot to subscribers on subscribe + broadcast", () => {
    const orchestrator = new Orchestrator();
    const dashboard = new StatusDashboard(orchestrator, { refreshMs: 60_000 });
    dashboard.start();

    const received: number[] = [];
    const unsubscribe = dashboard.subscribe((snap) => {
      received.push(snap.metrics.runningCount);
    });

    dashboard.broadcastSnapshot();
    expect(received.length).toBeGreaterThanOrEqual(1);

    unsubscribe();
    dashboard.broadcastSnapshot();
    // After unsubscribe, our handler shouldn't get further events.
    const lengthAfter = received.length;
    dashboard.broadcastSnapshot();
    expect(received.length).toBe(lengthAfter);

    dashboard.stop();
  });

  it("snapshot includes generatedAt + orchestrator state", () => {
    const orchestrator = new Orchestrator();
    const dashboard = new StatusDashboard(orchestrator);
    const snap = dashboard.snapshot();
    expect(typeof snap.generatedAt).toBe("string");
    expect(snap.orchestrator).toBeDefined();
    expect(snap.metrics).toBeDefined();
  });
});
