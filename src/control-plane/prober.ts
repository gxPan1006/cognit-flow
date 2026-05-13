import { logger } from "../log-file.js";
import type { ProjectEntry, Registry } from "./registry.js";

/**
 * Periodically pings each registered project runtime so the control plane can
 * show live status without owning their orchestrators.
 *  (113 LOC).
 */

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

export interface ProberOptions {
  registry: Registry;
  intervalMs?: number;
  requestTimeoutMs?: number;
  requestFn?: (url: string) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }>;
}

export class Prober {
  #registry: Registry;
  #intervalMs: number;
  #requestFn: (url: string) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }>;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(opts: ProberOptions) {
    this.#registry = opts.registry;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#requestFn = opts.requestFn ?? probeRuntime(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  start(): void {
    if (this.#stopped) return;
    this.#scheduleTick(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async probeOnce(): Promise<void> {
    const entries = this.#registry.list();
    await Promise.all(entries.map((entry) => this.#probeEntry(entry)));
  }

  #scheduleTick(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      try {
        await this.probeOnce();
      } catch (err) {
        logger().error({ err }, "Prober tick failed");
      }
      if (!this.#stopped) this.#scheduleTick(this.#intervalMs);
    }, delay);
  }

  async #probeEntry(entry: ProjectEntry): Promise<void> {
    const url = `http://127.0.0.1:${entry.port}/api/snapshot`;
    const result = await this.#requestFn(url);
    if (result.ok) {
      this.#registry.updateRuntimeState(entry.id, {
        status: "running",
        lastProbeAt: new Date(),
        lastState: result.body,
        lastError: null,
      });
      return;
    }
    if (result.reason === "connection_refused") {
      this.#registry.updateRuntimeState(entry.id, {
        status: entry.status === "starting" ? "starting" : "stopped",
        lastProbeAt: new Date(),
        lastState: null,
        lastError: null,
      });
      return;
    }
    this.#registry.updateRuntimeState(entry.id, {
      status: "error",
      lastProbeAt: new Date(),
      lastError: result.reason,
    });
  }
}

function probeRuntime(timeoutMs: number) {
  return async (
    url: string,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status !== 200) {
        return { ok: false, reason: `unexpected_status:${response.status}` };
      }
      const body = (await response.json()) as Record<string, unknown>;
      return { ok: true, body };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || (err instanceof Error && err.message.includes("ECONNREFUSED"))) {
        return { ok: false, reason: "connection_refused" };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}
