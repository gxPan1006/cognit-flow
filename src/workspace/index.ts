import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execa } from "execa";
import { settingsOrThrow } from "../config/index.js";
import { logger } from "../log-file.js";
import { canonicalize } from "../path-safety.js";

/**
 * Per-issue workspace lifecycle.  (483 LOC).
 *
 * Scope: local-only. The Elixir module also supports remote SSH workers via
 * `worker.ssh_hosts`; that path is stubbed here because the default config has
 * an empty `ssh_hosts` list. Remote support will land alongside the SSH module
 * port.
 */

export interface IssueContext {
  issueId: string | null;
  issueIdentifier: string;
}

export type WorkspaceError =
  | { kind: "workspace_equals_root"; workspace: string; root: string }
  | { kind: "workspace_symlink_escape"; workspace: string; root: string }
  | { kind: "workspace_outside_root"; workspace: string; root: string }
  | { kind: "workspace_path_unreadable"; path: string; reason: unknown }
  | { kind: "workspace_hook_failed"; hook: HookName; status: number; output: string }
  | { kind: "workspace_hook_timeout"; hook: HookName | "remote_command"; timeoutMs: number }
  | { kind: "workspace_creation_failed"; reason: unknown }
  | { kind: "remote_unsupported" };

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: WorkspaceError };

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export interface CreatedWorkspace {
  path: string;
  createdNow: boolean;
}

/**
 * Resolve and create the workspace for an issue. Mirrors
 * Workspace.create_for_issue/2 (local-only).
 */
export async function createForIssue(
  issueOrIdentifier: { id?: string | null; identifier?: string | null } | string | null,
  workerHost: string | null = null,
): Promise<WorkspaceResult<string>> {
  if (workerHost) return { ok: false, error: { kind: "remote_unsupported" } };

  const ctx = issueContext(issueOrIdentifier);
  const safeId = safeIdentifier(ctx.issueIdentifier);

  const wsPath = await workspacePathForIssue(safeId);
  if (!wsPath.ok) return wsPath;

  const validate = await validateWorkspacePath(wsPath.value);
  if (!validate.ok) return validate;

  const ensured = await ensureWorkspace(wsPath.value);
  if (!ensured.ok) return ensured;

  const hook = await maybeRunAfterCreateHook(ensured.value.path, ctx, ensured.value.createdNow);
  if (!hook.ok) return hook;

  return { ok: true, value: ensured.value.path };
}

/**
 * Remove a workspace, optionally running the before_remove hook first.
 * Mirrors Workspace.remove/2 (local).
 */
export async function remove(workspace: string): Promise<WorkspaceResult<void>> {
  if (!(await pathExists(workspace))) {
    return { ok: true, value: undefined };
  }
  const validate = await validateWorkspacePath(workspace);
  if (!validate.ok) return validate;

  await maybeRunBeforeRemoveHook(workspace);

  try {
    await fsp.rm(workspace, { recursive: true, force: true });
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: { kind: "workspace_creation_failed", reason: err } };
  }
}

/**
 * Remove the workspace for a specific issue identifier across all configured
 * worker hosts. Mirrors Workspace.remove_issue_workspaces/{1,2}.
 */
export async function removeIssueWorkspaces(identifier: string): Promise<void> {
  const safeId = safeIdentifier(identifier);
  const wsPath = await workspacePathForIssue(safeId);
  if (wsPath.ok) {
    await remove(wsPath.value);
  }
}

/**
 * Run the `before_run` hook if configured. Failure aborts the attempt.
 */
export async function runBeforeRunHook(
  workspace: string,
  issueOrIdentifier: { id?: string | null; identifier?: string | null } | string | null,
): Promise<WorkspaceResult<void>> {
  const s = await settingsOrThrow();
  const command = s.hooks.before_run;
  if (!command) return { ok: true, value: undefined };

  return runHook(command, workspace, issueContext(issueOrIdentifier), "before_run");
}

/**
 * Run the `after_run` hook if configured. Failures are logged but ignored,
 * matching the Elixir contract.
 */
export async function runAfterRunHook(
  workspace: string,
  issueOrIdentifier: { id?: string | null; identifier?: string | null } | string | null,
): Promise<WorkspaceResult<void>> {
  const s = await settingsOrThrow();
  const command = s.hooks.after_run;
  if (!command) return { ok: true, value: undefined };

  const result = await runHook(command, workspace, issueContext(issueOrIdentifier), "after_run");
  return result.ok ? result : { ok: true, value: undefined };
}

// ---- internal helpers ----

async function workspacePathForIssue(safeId: string): Promise<WorkspaceResult<string>> {
  const s = await settingsOrThrow();
  const candidate = path.join(s.workspace.root, safeId);
  const canon = canonicalize(candidate);
  if (!canon.ok) {
    return {
      ok: false,
      error: { kind: "workspace_path_unreadable", path: candidate, reason: canon.reason },
    };
  }
  return { ok: true, value: canon.path };
}

function safeIdentifier(identifier: string | null | undefined): string {
  const base = identifier && identifier !== "" ? identifier : "issue";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function ensureWorkspace(workspace: string): Promise<WorkspaceResult<CreatedWorkspace>> {
  try {
    const stat = await fsp.stat(workspace);
    if (stat.isDirectory()) {
      return { ok: true, value: { path: workspace, createdNow: false } };
    }
    await fsp.rm(workspace, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { ok: false, error: { kind: "workspace_creation_failed", reason: err } };
    }
  }

  try {
    await fsp.mkdir(workspace, { recursive: true });
    return { ok: true, value: { path: workspace, createdNow: true } };
  } catch (err) {
    return { ok: false, error: { kind: "workspace_creation_failed", reason: err } };
  }
}

async function maybeRunAfterCreateHook(
  workspace: string,
  ctx: IssueContext,
  createdNow: boolean,
): Promise<WorkspaceResult<void>> {
  if (!createdNow) return { ok: true, value: undefined };
  const s = await settingsOrThrow();
  const command = s.hooks.after_create;
  if (!command) return { ok: true, value: undefined };
  return runHook(command, workspace, ctx, "after_create");
}

async function maybeRunBeforeRemoveHook(workspace: string): Promise<void> {
  let isDir = false;
  try {
    isDir = (await fsp.stat(workspace)).isDirectory();
  } catch {
    return;
  }
  if (!isDir) return;

  const s = await settingsOrThrow();
  const command = s.hooks.before_remove;
  if (!command) return;

  await runHook(
    command,
    workspace,
    { issueId: null, issueIdentifier: path.basename(workspace) },
    "before_remove",
  );
}

async function runHook(
  command: string,
  workspace: string,
  ctx: IssueContext,
  hookName: HookName,
): Promise<WorkspaceResult<void>> {
  const s = await settingsOrThrow();
  const timeoutMs = s.hooks.timeout_ms;
  const log = logger();

  log.info(
    {
      hook: hookName,
      issue_id: ctx.issueId ?? "n/a",
      issue_identifier: ctx.issueIdentifier,
      workspace,
      worker_host: "local",
    },
    "Running workspace hook",
  );

  try {
    const result = await execa("sh", ["-lc", command], {
      cwd: workspace,
      timeout: timeoutMs,
      reject: false,
      all: true,
    });

    if (result.timedOut) {
      log.warn(
        { hook: hookName, workspace, timeoutMs },
        "Workspace hook timed out",
      );
      return { ok: false, error: { kind: "workspace_hook_timeout", hook: hookName, timeoutMs } };
    }

    if (result.exitCode === 0) {
      return { ok: true, value: undefined };
    }

    const output = result.all ?? result.stdout ?? "";
    log.warn(
      {
        hook: hookName,
        issue_identifier: ctx.issueIdentifier,
        workspace,
        status: result.exitCode,
        output: sanitizeHookOutput(output),
      },
      "Workspace hook failed",
    );
    return {
      ok: false,
      error: {
        kind: "workspace_hook_failed",
        hook: hookName,
        status: result.exitCode ?? -1,
        output,
      },
    };
  } catch (err) {
    log.warn({ hook: hookName, workspace, err }, "Workspace hook crashed");
    return {
      ok: false,
      error: { kind: "workspace_creation_failed", reason: err },
    };
  }
}

async function validateWorkspacePath(workspace: string): Promise<WorkspaceResult<void>> {
  const s = await settingsOrThrow();
  const expandedWs = path.resolve(workspace);
  const expandedRoot = path.resolve(s.workspace.root);

  const wsCanon = canonicalize(expandedWs);
  const rootCanon = canonicalize(expandedRoot);
  if (!wsCanon.ok) {
    return {
      ok: false,
      error: { kind: "workspace_path_unreadable", path: expandedWs, reason: wsCanon.reason },
    };
  }
  if (!rootCanon.ok) {
    return {
      ok: false,
      error: { kind: "workspace_path_unreadable", path: expandedRoot, reason: rootCanon.reason },
    };
  }

  const canonWs = wsCanon.path;
  const canonRoot = rootCanon.path;
  const canonRootPrefix = canonRoot + path.sep;
  const expandedRootPrefix = expandedRoot + path.sep;

  if (canonWs === canonRoot) {
    return { ok: false, error: { kind: "workspace_equals_root", workspace: canonWs, root: canonRoot } };
  }
  if ((canonWs + path.sep).startsWith(canonRootPrefix)) {
    return { ok: true, value: undefined };
  }
  if ((expandedWs + path.sep).startsWith(expandedRootPrefix)) {
    return {
      ok: false,
      error: { kind: "workspace_symlink_escape", workspace: expandedWs, root: canonRoot },
    };
  }
  return {
    ok: false,
    error: { kind: "workspace_outside_root", workspace: canonWs, root: canonRoot },
  };
}

function issueContext(
  input: { id?: string | null; identifier?: string | null } | string | null | undefined,
): IssueContext {
  if (typeof input === "string") {
    return { issueId: null, issueIdentifier: input };
  }
  if (input && typeof input === "object") {
    return {
      issueId: input.id ?? null,
      issueIdentifier: input.identifier && input.identifier !== "" ? input.identifier : "issue",
    };
  }
  return { issueId: null, issueIdentifier: "issue" };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sanitizeHookOutput(output: string, maxBytes = 2048): string {
  if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
  return Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8") + "... (truncated)";
}
