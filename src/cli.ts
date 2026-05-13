#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { serverPort, setLanguage, setServerPortOverride } from "./config/index.js";
import { start as startControlPlane, type RunningControlPlane } from "./control-plane/index.js";
import { start as startHttpServer, type RunningHttpServer } from "./http-server/index.js";
import { configure as configureLogFile, defaultLogFile, logger } from "./log-file.js";
import { Orchestrator } from "./orchestrator/index.js";
import { StatusDashboard } from "./status-dashboard/index.js";
import { setWorkflowFilePath } from "./workflow/loader.js";
import { workflowStore } from "./workflow/store.js";
import { load } from "./workflow/loader.js";

/**
 * Escript-equivalent entrypoint.  — supports
 *   --i-understand-that-this-will-be-running-without-the-usual-guardrails
 *   --control-plane
 *   --logs-root <path>
 *   --port <int>
 *   --language <name>
 *   [path-to-WORKFLOW.md]
 */

const ACK_FLAG = "i-understand-that-this-will-be-running-without-the-usual-guardrails";

type RuntimeMode = "project" | "control_plane";

let runtimeMode: RuntimeMode = "project";
export function getRuntimeMode(): RuntimeMode {
  return runtimeMode;
}
function setRuntimeMode(mode: RuntimeMode): void {
  runtimeMode = mode;
}

interface ParsedArgs {
  ack: boolean;
  controlPlane: boolean;
  logsRoot?: string | undefined;
  port?: number | undefined;
  language?: string | undefined;
  workflowPath?: string | undefined;
}

export async function main(argv: readonly string[] = hideBin(process.argv)): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + "\n");
    process.exit(1);
    return;
  }

  if (!parsed.ack) {
    process.stderr.write(acknowledgementBanner() + "\n");
    process.exit(1);
    return;
  }

  if (parsed.logsRoot !== undefined) {
    process.env.COGNITION_LOG_FILE = defaultLogFile(path.resolve(parsed.logsRoot));
  }
  if (parsed.port !== undefined) {
    setServerPortOverride(parsed.port);
  }
  if (parsed.language !== undefined) {
    setLanguage(parsed.language);
  }

  configureLogFile();

  if (parsed.controlPlane) {
    setRuntimeMode("control_plane");
    await startControlPlaneCli();
    return;
  }

  const workflowPath = parsed.workflowPath
    ? path.resolve(parsed.workflowPath)
    : path.join(process.cwd(), "WORKFLOW.md");

  if (!isRegularFile(workflowPath)) {
    process.stderr.write(`Workflow file not found: ${workflowPath}\n`);
    process.exit(1);
    return;
  }

  setWorkflowFilePath(workflowPath);
  setRuntimeMode("project");
  await startProject();
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed = yargs(argv as string[])
    .help(false)
    .version(false)
    .exitProcess(false)
    .fail((msg, err) => {
      throw err ?? new Error(msg ?? usageMessage());
    })
    .option(ACK_FLAG, { type: "boolean", default: false })
    .option("control-plane", { type: "boolean", default: false })
    .option("logs-root", { type: "string" })
    .option("port", { type: "number" })
    .option("language", { type: "string" })
    .command("$0 [workflow]", "run cognit-flow", (y) =>
      y.positional("workflow", { type: "string", describe: "path to WORKFLOW.md" }),
    )
    .parseSync();

  const positional = parsed._.map((v) => String(v));
  if (positional.length > 1) {
    throw new Error(usageMessage());
  }
  const workflowPositional =
    typeof parsed.workflow === "string" ? parsed.workflow : positional[0];

  const logsRoot = parsed["logs-root"];
  if (typeof logsRoot === "string" && logsRoot.trim() === "") {
    throw new Error(usageMessage());
  }
  const language = parsed.language;
  if (typeof language === "string" && language.trim() === "") {
    throw new Error(usageMessage());
  }
  const port = parsed.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 0)) {
    throw new Error(usageMessage());
  }

  return {
    ack: parsed[ACK_FLAG] === true,
    controlPlane: parsed["control-plane"] === true,
    logsRoot: typeof logsRoot === "string" ? logsRoot.trim() : undefined,
    port,
    language: typeof language === "string" ? language.trim() : undefined,
    workflowPath: workflowPositional,
  };
}

function usageMessage(): string {
  return "Usage: cognit-flow [--control-plane] [--logs-root <path>] [--port <port>] [--language <name>] [path-to-WORKFLOW.md]";
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function acknowledgementBanner(): string {
  const lines = [
    "This Cognit Flow implementation is a low key engineering preview.",
    "The configured coding tool will run without any guardrails.",
    "Cognit Flow is not a supported product and is presented as-is.",
    "To proceed, start with `--i-understand-that-this-will-be-running-without-the-usual-guardrails` CLI argument",
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const border = "─".repeat(width + 2);
  const top = "╭" + border + "╮";
  const bottom = "╰" + border + "╯";
  const spacer = "│ " + " ".repeat(width) + " │";

  const content = [top, spacer];
  for (const line of lines) {
    content.push("│ " + line.padEnd(width, " ") + " │");
  }
  content.push(spacer, bottom);

  const red = "\x1b[31m";
  const bright = "\x1b[1m";
  const reset = "\x1b[0m";
  return `${red}${bright}${content.join("\n")}${reset}`;
}

async function startProject(): Promise<void> {
  const loaded = await load();
  if (!loaded.ok) {
    process.stderr.write(`Failed to start Cognit Flow: ${JSON.stringify(loaded.error)}\n`);
    process.exit(1);
    return;
  }
  workflowStore.set(loaded.value);

  // Build orchestrator + dashboard with mutual wiring (dashboard reads
  // snapshots from orchestrator; orchestrator pushes onUpdate to dashboard).
  let dashboardRef: StatusDashboard | null = null;
  const orchestrator = new Orchestrator({
    onUpdate: () => dashboardRef?.broadcastSnapshot(),
  });
  const dashboard = new StatusDashboard(orchestrator);
  dashboardRef = dashboard;

  try {
    await orchestrator.start();
  } catch (err) {
    process.stderr.write(`Failed to start orchestrator: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }
  dashboard.start();

  const port = await serverPort();
  let server: RunningHttpServer | null = null;
  if (port !== null) {
    try {
      server = await startHttpServer({ port, dashboard });
      process.stderr.write(`[cognit-flow] dashboard at http://${server.address.host}:${server.address.port}\n`);
    } catch (err) {
      process.stderr.write(`[cognit-flow] failed to start HTTP server: ${String(err)}\n`);
    }
  }

  logger().info({ workflow: loaded.value.config }, "Cognit Flow orchestrator started");

  await waitForShutdown();
  if (server) await server.stop();
  dashboard.stop();
  await orchestrator.stop();
}

async function startControlPlaneCli(): Promise<void> {
  const port = (await serverPortOrDefault()) ?? 4000;
  let server: RunningControlPlane;
  try {
    server = await startControlPlane({ port });
  } catch (err) {
    process.stderr.write(`Failed to start control plane: ${String(err)}\n`);
    process.exit(1);
    return;
  }
  process.stderr.write(`[cognit-flow] control plane at http://${server.address.host}:${server.address.port}\n`);
  logger().info({ port: server.address.port }, "Cognit Flow control plane started");

  await waitForShutdown();
  await server.stop();
}

async function serverPortOrDefault(): Promise<number | null> {
  try {
    return await serverPort();
  } catch {
    return null;
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
