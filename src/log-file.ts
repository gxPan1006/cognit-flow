import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";

const DEFAULT_LOG_RELATIVE = "log/cognit-flow.log";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export interface LogFileConfig {
  logFile: string;
  maxBytes: number;
  maxFiles: number;
}

/**
 * Resolve the default log file path, mirroring LogFile.default_log_file/{0,1}.
 */
export function defaultLogFile(logsRoot: string = process.cwd()): string {
  return path.join(logsRoot, DEFAULT_LOG_RELATIVE);
}

let activeLogger: pino.Logger | null = null;

/**
 * Configure the rotating disk log handler. Mirrors LogFile.configure/0 — applies
 * env-controlled overrides for path/size/file count, ensures parent dir exists,
 * and replaces any previous handler in place.
 */
export function configure(overrides: Partial<LogFileConfig> = {}): pino.Logger {
  const config: LogFileConfig = {
    logFile: overrides.logFile ?? process.env.COGNIT_FLOW_LOG_FILE ?? defaultLogFile(),
    maxBytes:
      overrides.maxBytes ??
      parseIntOr(process.env.COGNIT_FLOW_LOG_FILE_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxFiles:
      overrides.maxFiles ??
      parseIntOr(process.env.COGNIT_FLOW_LOG_FILE_MAX_FILES, DEFAULT_MAX_FILES),
  };

  const expanded = path.resolve(config.logFile);
  fs.mkdirSync(path.dirname(expanded), { recursive: true });

  // pino-roll has a small async surface; we use a synchronous-friendly setup
  // since the Elixir behavior is "configure once and continue". For now we
  // fall back to a plain file destination — rotation wiring can be tightened
  // when StatusDashboard is ported and starts producing real log volume.
  const dest = pino.destination({ dest: expanded, sync: false, mkdir: true });
  activeLogger = pino(
    {
      level: process.env.COGNIT_FLOW_LOG_LEVEL ?? "info",
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );

  return activeLogger;
}

export function logger(): pino.Logger {
  if (!activeLogger) {
    return configure();
  }
  return activeLogger;
}

/**
 * Replace the active logger (useful for tests).
 */
export function setLogger(next: pino.Logger | null): void {
  activeLogger = next;
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
