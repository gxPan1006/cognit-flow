import * as fs from "node:fs";
import * as net from "node:net";
import { execa } from "execa";
import type { ProjectEntry } from "./registry.js";

/**
 * Start, stop, and restart a project's dedicated Cognit Flow runtime by driving
 * its tmux session and probing the dashboard port.
 *  (~187 LOC).
 */

const PORT_WAIT_MS = 30_000;
const PORT_CHECK_INTERVAL_MS = 500;
const PORT_CONNECT_TIMEOUT_MS = 200;

export interface RuntimeStartResult {
  ok: true;
  url: string;
  warnings: string[];
}
export interface RuntimeError {
  ok: false;
  error: string;
}

export type RuntimeResult = RuntimeStartResult | RuntimeError;

export async function start(entry: ProjectEntry): Promise<RuntimeResult> {
  const validation = validateRuntimeFiles(entry);
  if (!validation.ok) return validation;

  const tmux = await findExecutable("tmux");
  if (!tmux) return { ok: false, error: "tmux is not installed on PATH" };

  const linearKey = process.env.LINEAR_API_KEY;
  if (!linearKey || linearKey === "") {
    return { ok: false, error: "LINEAR_API_KEY is not set in the control plane environment" };
  }

  // Idempotent: kill any prior session of the same name.
  await tryRun(tmux, ["kill-session", "-t", entry.tmuxSession]);

  const newSession = await runCommand(tmux, [
    "new-session",
    "-d",
    "-s",
    entry.tmuxSession,
    "-c",
    entry.projectPath,
    "/bin/zsh",
  ]);
  if (!newSession.ok) return newSession;

  const setKey = await runCommand(tmux, [
    "set-environment",
    "-t",
    entry.tmuxSession,
    "LINEAR_API_KEY",
    linearKey,
  ]);
  if (!setKey.ok) return setKey;

  const pathEnv = process.env.PATH;
  if (pathEnv && pathEnv !== "") {
    await tryRun(tmux, ["set-environment", "-t", entry.tmuxSession, "PATH", pathEnv]);
  }

  const launch = await runCommand(tmux, [
    "send-keys",
    "-t",
    entry.tmuxSession,
    `exec ${shellQuote(entry.runnerPath)}`,
    "C-m",
  ]);
  if (!launch.ok) return launch;

  const listening = await waitForPort(entry.port);
  return {
    ok: true,
    url: `http://127.0.0.1:${entry.port}/`,
    warnings: listening ? [] : runtimeWarnings(entry.port),
  };
}

export async function stop(entry: ProjectEntry): Promise<{ ok: true }> {
  const tmux = await findExecutable("tmux");
  if (tmux) await tryRun(tmux, ["kill-session", "-t", entry.tmuxSession]);
  await killPortOwner(entry.port);
  return { ok: true };
}

export async function restart(entry: ProjectEntry): Promise<RuntimeResult> {
  await stop(entry);
  return start(entry);
}

// ---- helpers ----

function validateRuntimeFiles(entry: ProjectEntry): { ok: true } | RuntimeError {
  if (!fs.existsSync(entry.workflowPath) || !fs.statSync(entry.workflowPath).isFile()) {
    return { ok: false, error: `Missing WORKFLOW.md at ${entry.workflowPath}` };
  }
  if (!fs.existsSync(entry.runnerPath) || !fs.statSync(entry.runnerPath).isFile()) {
    return { ok: false, error: `Missing runner script at ${entry.runnerPath}` };
  }
  return { ok: true };
}

async function findExecutable(name: string): Promise<string | null> {
  try {
    const result = await execa("which", [name], { reject: false });
    const stdout = result.stdout?.trim();
    return stdout && result.exitCode === 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function runCommand(command: string, args: string[]): Promise<{ ok: true } | RuntimeError> {
  try {
    const result = await execa(command, args, { reject: false, all: true });
    if (result.exitCode === 0) return { ok: true };
    return {
      ok: false,
      error: `command failed (status=${result.exitCode}): ${(result.all ?? "").trim()}`,
    };
  } catch (err) {
    return { ok: false, error: `command crashed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function tryRun(command: string, args: string[]): Promise<void> {
  try {
    await execa(command, args, { reject: false });
  } catch {
    /* ignore */
  }
}

async function killPortOwner(port: number): Promise<void> {
  if (!Number.isInteger(port) || port <= 0) return;
  const lsof = await findExecutable("lsof");
  if (!lsof) return;
  try {
    const result = await execa(lsof, [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
      reject: false,
      all: true,
    });
    const pids = (result.stdout ?? "").split(/\s+/).filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      await tryRun("/bin/kill", ["-TERM", pid]);
    }
  } catch {
    /* ignore */
  }
}

function waitForPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const iterations = Math.floor(PORT_WAIT_MS / PORT_CHECK_INTERVAL_MS);
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const socket = net.connect({ port, host: "127.0.0.1", timeout: PORT_CONNECT_TIMEOUT_MS });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (attempt >= iterations) {
          resolve(false);
          return;
        }
        setTimeout(tryOnce, PORT_CHECK_INTERVAL_MS);
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (attempt >= iterations) {
          resolve(false);
          return;
        }
        setTimeout(tryOnce, PORT_CHECK_INTERVAL_MS);
      });
    };
    tryOnce();
  });
}

function runtimeWarnings(port: number): string[] {
  return [
    `Runtime was launched, but port ${port} was not listening within ${PORT_WAIT_MS / 1000} seconds.`,
  ];
}

function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}
