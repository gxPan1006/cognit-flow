import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "../log-file.js";

/**
 * Persistent list of project runtimes managed by the control plane.
 *  (~395 LOC).
 *
 * Stored on disk as JSON for survival across restarts. Runtime-only fields
 * (status, last_probe_at, last_state, last_error) are reset on load.
 */

const PERSISTENCE_VERSION = 1;

export type RuntimeStatus = "unknown" | "starting" | "running" | "stopped" | "error";

export interface ProjectEntry {
  id: string;
  name: string;
  projectPath: string;
  workflowPath: string;
  runnerPath: string;
  tmuxSession: string;
  port: number;
  linearUrl: string | null;
  codingTool: string;
  workspaceRoot: string;
  createdAt: Date;
  status: RuntimeStatus;
  lastProbeAt: Date | null;
  lastState: Record<string, unknown> | null;
  lastError: string | null;
}

export interface RegisterAttrs {
  id?: string;
  name: string;
  projectPath: string;
  workflowPath: string;
  runnerPath: string;
  tmuxSession: string;
  port: number;
  linearUrl?: string | null;
  codingTool: string;
  workspaceRoot: string;
}

export type RegistrySubscriber = (event: RegistryEvent) => void;
export type RegistryEvent =
  | { kind: "project_registered"; entry: ProjectEntry }
  | { kind: "project_unregistered"; id: string }
  | { kind: "project_runtime_changed"; entry: ProjectEntry };

export class Registry {
  #entries: ProjectEntry[] = [];
  #persistencePath: string;
  #subscribers = new Set<RegistrySubscriber>();
  #loaded = false;

  constructor(opts: { persistencePath?: string } = {}) {
    this.#persistencePath = opts.persistencePath ?? defaultPersistencePath();
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#entries = await loadFromDisk(this.#persistencePath);
    this.#loaded = true;
  }

  list(): ProjectEntry[] {
    return [...this.#entries];
  }

  fetch(id: string): ProjectEntry | null {
    return this.#entries.find((e) => e.id === id) ?? null;
  }

  async register(attrs: RegisterAttrs): Promise<{ ok: true; entry: ProjectEntry } | { ok: false; error: string }> {
    const validation = validateAttrs(attrs);
    if (!validation.ok) return validation;

    const existing = attrs.id ? this.#entries.find((e) => e.id === attrs.id) : null;
    const entry: ProjectEntry = {
      id: attrs.id ?? existing?.id ?? deriveId(attrs.name, attrs.port),
      name: attrs.name.trim(),
      projectPath: attrs.projectPath.trim(),
      workflowPath: attrs.workflowPath.trim(),
      runnerPath: attrs.runnerPath.trim(),
      tmuxSession: attrs.tmuxSession.trim(),
      port: attrs.port,
      linearUrl: attrs.linearUrl ?? null,
      codingTool: attrs.codingTool.trim(),
      workspaceRoot: attrs.workspaceRoot.trim(),
      createdAt: existing?.createdAt ?? new Date(),
      status: existing?.status ?? "unknown",
      lastProbeAt: existing?.lastProbeAt ?? null,
      lastState: existing?.lastState ?? null,
      lastError: existing?.lastError ?? null,
    };

    this.#upsert(entry);
    await this.#persist();
    this.#broadcast({ kind: "project_registered", entry });
    return { ok: true, entry };
  }

  async unregister(id: string): Promise<void> {
    const idx = this.#entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    this.#entries.splice(idx, 1);
    await this.#persist();
    this.#broadcast({ kind: "project_unregistered", id });
  }

  updateRuntimeState(id: string, runtimeState: Partial<Pick<ProjectEntry, "status" | "lastProbeAt" | "lastState" | "lastError">>): void {
    const idx = this.#entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const updated = { ...this.#entries[idx]!, ...runtimeState };
    this.#entries[idx] = updated;
    this.#broadcast({ kind: "project_runtime_changed", entry: updated });
  }

  subscribe(subscriber: RegistrySubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  #upsert(entry: ProjectEntry): void {
    const idx = this.#entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) this.#entries.push(entry);
    else this.#entries[idx] = entry;
  }

  #broadcast(event: RegistryEvent): void {
    for (const sub of this.#subscribers) {
      try {
        sub(event);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  async #persist(): Promise<void> {
    const payload = {
      version: PERSISTENCE_VERSION,
      projects: this.#entries.map(serialise),
    };
    try {
      await fs.mkdir(path.dirname(this.#persistencePath), { recursive: true });
      await fs.writeFile(this.#persistencePath, JSON.stringify(payload, null, 2));
    } catch (err) {
      logger().warn({ err, path: this.#persistencePath }, "Failed to persist control plane registry");
    }
  }
}

function validateAttrs(attrs: RegisterAttrs): { ok: true } | { ok: false; error: string } {
  for (const key of [
    "name",
    "projectPath",
    "workflowPath",
    "runnerPath",
    "tmuxSession",
    "codingTool",
    "workspaceRoot",
  ] as const) {
    const value = attrs[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: `missing_field:${key}` };
    }
  }
  if (!Number.isInteger(attrs.port) || attrs.port <= 0) {
    return { ok: false, error: "invalid_field:port" };
  }
  return { ok: true };
}

function deriveId(name: string, port: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "project"}-${port}`;
}

function serialise(entry: ProjectEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    project_path: entry.projectPath,
    workflow_path: entry.workflowPath,
    runner_path: entry.runnerPath,
    tmux_session: entry.tmuxSession,
    port: entry.port,
    linear_url: entry.linearUrl,
    coding_tool: entry.codingTool,
    workspace_root: entry.workspaceRoot,
    created_at: entry.createdAt.toISOString(),
  };
}

async function loadFromDisk(filePath: string): Promise<ProjectEntry[]> {
  let body: string;
  try {
    body = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return [];
  }
  if (!decoded || typeof decoded !== "object") return [];
  const projects = (decoded as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return [];

  const out: ProjectEntry[] = [];
  for (const raw of projects) {
    const entry = deserialise(raw);
    if (entry) out.push(entry);
  }
  return out;
}

function deserialise(raw: unknown): ProjectEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const requireString = (key: string): string | null => {
    const value = r[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    return null;
  };
  const name = requireString("name");
  const projectPath = requireString("project_path");
  const workflowPath = requireString("workflow_path");
  const runnerPath = requireString("runner_path");
  const tmuxSession = requireString("tmux_session");
  const codingTool = requireString("coding_tool");
  const workspaceRoot = requireString("workspace_root");
  const portRaw = r.port;
  const port =
    typeof portRaw === "number" && Number.isInteger(portRaw) && portRaw > 0
      ? portRaw
      : typeof portRaw === "string" && /^\d+$/.test(portRaw)
        ? Number.parseInt(portRaw, 10)
        : null;
  if (!name || !projectPath || !workflowPath || !runnerPath || !tmuxSession || !codingTool || !workspaceRoot || port === null) {
    return null;
  }
  const createdAtRaw = r.created_at;
  let createdAt = new Date();
  if (typeof createdAtRaw === "string") {
    const parsed = new Date(createdAtRaw);
    if (!Number.isNaN(parsed.getTime())) createdAt = parsed;
  }
  const id = typeof r.id === "string" ? r.id : deriveId(name, port);
  return {
    id,
    name,
    projectPath,
    workflowPath,
    runnerPath,
    tmuxSession,
    port,
    linearUrl: typeof r.linear_url === "string" ? r.linear_url : null,
    codingTool,
    workspaceRoot,
    createdAt,
    status: "unknown",
    lastProbeAt: null,
    lastState: null,
    lastError: null,
  };
}

export function defaultPersistencePath(): string {
  return path.join(os.homedir(), ".cognit-flow", "projects.json");
}
