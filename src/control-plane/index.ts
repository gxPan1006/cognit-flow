import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "../log-file.js";
import { Prober } from "./prober.js";
import { Registry, type RegisterAttrs } from "./registry.js";
import * as runtime from "./project-runtime.js";

/**
 * Control plane HTTP server. {Registry,Prober,
 * ProjectRuntime} + the HTTP surface that fronts them.
 *
 * Routes:
 *   - GET    /api/projects             — list registered runtimes
 *   - POST   /api/projects             — register/upsert a runtime
 *   - DELETE /api/projects/:id         — unregister
 *   - POST   /api/projects/:id/start   — start (or restart) tmux runtime
 *   - POST   /api/projects/:id/stop    — stop tmux runtime
 *   - POST   /api/projects/:id/restart — restart tmux runtime
 *   - GET    /healthz                  — liveness probe
 */

export interface ControlPlaneOptions {
  port: number;
  host?: string;
  persistencePath?: string;
  probeIntervalMs?: number;
}

export interface RunningControlPlane {
  stop: () => Promise<void>;
  address: { host: string; port: number };
  registry: Registry;
  prober: Prober;
}

export async function start(opts: ControlPlaneOptions): Promise<RunningControlPlane> {
  const registry = new Registry(
    opts.persistencePath !== undefined ? { persistencePath: opts.persistencePath } : {},
  );
  await registry.load();

  const prober = new Prober(
    opts.probeIntervalMs !== undefined
      ? { registry, intervalMs: opts.probeIntervalMs }
      : { registry },
  );
  prober.start();

  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/api/projects", (c) => c.json({ projects: registry.list() }));

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<RegisterAttrs>();
    const result = await registry.register(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.entry, 201);
  });

  app.delete("/api/projects/:id", async (c) => {
    await registry.unregister(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/projects/:id/start", async (c) => {
    const entry = registry.fetch(c.req.param("id"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    const result = await runtime.start(entry);
    if (!result.ok) {
      registry.updateRuntimeState(entry.id, {
        status: "error",
        lastError: result.error,
        lastProbeAt: new Date(),
      });
      return c.json({ error: result.error }, 500);
    }
    registry.updateRuntimeState(entry.id, {
      status: "starting",
      lastError: null,
      lastProbeAt: new Date(),
    });
    return c.json({ url: result.url, warnings: result.warnings });
  });

  app.post("/api/projects/:id/stop", async (c) => {
    const entry = registry.fetch(c.req.param("id"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    await runtime.stop(entry);
    registry.updateRuntimeState(entry.id, { status: "stopped", lastError: null });
    return c.json({ stopped: entry.id });
  });

  app.post("/api/projects/:id/restart", async (c) => {
    const entry = registry.fetch(c.req.param("id"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    const result = await runtime.restart(entry);
    if (!result.ok) {
      registry.updateRuntimeState(entry.id, {
        status: "error",
        lastError: result.error,
        lastProbeAt: new Date(),
      });
      return c.json({ error: result.error }, 500);
    }
    registry.updateRuntimeState(entry.id, {
      status: "starting",
      lastError: null,
      lastProbeAt: new Date(),
    });
    return c.json({ url: result.url, warnings: result.warnings });
  });

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host ?? "127.0.0.1" }, (info) => {
      logger().info({ host: info.address, port: info.port }, "Control plane listening");
      resolve({
        address: { host: info.address, port: info.port },
        registry,
        prober,
        async stop() {
          prober.stop();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

export { Registry } from "./registry.js";
export { Prober } from "./prober.js";
