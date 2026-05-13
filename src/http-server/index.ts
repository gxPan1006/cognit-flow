import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger as makeLogger } from "../log-file.js";
import type { StatusDashboard } from "../status-dashboard/index.js";
import { renderDashboardHtml } from "./dashboard-page.js";

/**
 * Hono-based HTTP server providing the observability dashboard. Mirrors
 * the observability dashboard.
 *
 * Routes:
 *   - GET  /           — server-rendered HTML dashboard that subscribes to /events via SSE
 *   - GET  /api/snapshot — JSON snapshot of orchestrator state
 *   - GET  /events     — Server-Sent Events stream of snapshot updates
 *   - GET  /healthz    — liveness probe
 */

export interface HttpServerOptions {
  port: number;
  host?: string;
  dashboard: StatusDashboard;
}

export interface RunningHttpServer {
  stop: () => Promise<void>;
  address: { host: string; port: number };
}

export async function start(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const dashboard = opts.dashboard;
  const host = opts.host ?? "127.0.0.1";

  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/", (c) => {
    const snapshot = dashboard.snapshot();
    return c.html(renderDashboardHtml(snapshot));
  });

  app.get("/api/snapshot", (c) => c.json(dashboard.snapshot()));

  app.get("/events", (c) => {
    const subscribers = new Set<(snapshot: unknown) => void>();
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const write = (data: unknown) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        write(dashboard.snapshot());

        const unsubscribe = dashboard.subscribe(write);
        subscribers.add(write);

        const heartbeat = setInterval(() => {
          controller.enqueue(enc.encode(": keep-alive\n\n"));
        }, 30_000);

        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          subscribers.delete(write);
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        for (const w of subscribers) subscribers.delete(w);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return new Promise<RunningHttpServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: host }, (info) => {
      makeLogger().info({ host: info.address, port: info.port }, "HTTP server listening");
      resolve({
        address: { host: info.address, port: info.port },
        async stop() {
          await new Promise<void>((res) => {
            server.close(() => res());
          });
        },
      });
    });
  });
}
