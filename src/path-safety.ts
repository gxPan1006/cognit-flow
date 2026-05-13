import * as fs from "node:fs";
import * as path from "node:path";

export type CanonicalizeOk = { ok: true; path: string };
export type CanonicalizeErr = { ok: false; reason: unknown };
export type CanonicalizeResult = CanonicalizeOk | CanonicalizeErr;

/**
 * Resolve a path to its canonical absolute form, following symlinks segment by
 * segment. /1 — non-existent suffix
 * segments are accepted (returned as-is appended to the resolved prefix), but
 * a stat error mid-path produces an error.
 */
export function canonicalize(input: string): CanonicalizeResult {
  const expanded = path.resolve(expandHome(input));
  const segments = expanded.split(path.sep).filter((segment) => segment.length > 0);
  const root = path.parse(expanded).root || path.sep;
  return resolveSegments(root, [], segments);
}

function resolveSegments(
  root: string,
  resolved: readonly string[],
  remaining: readonly string[],
): CanonicalizeResult {
  if (remaining.length === 0) {
    return { ok: true, path: joinPath(root, resolved) };
  }

  const [next, ...rest] = remaining as [string, ...string[]];
  const candidate = joinPath(root, [...resolved, next]);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, path: joinPath(root, [...resolved, next, ...rest]) };
    }
    return { ok: false, reason: { expanded: candidate, error: err } };
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(candidate);
    } catch (err) {
      return { ok: false, reason: err };
    }
    const base = joinPath(root, resolved);
    const resolvedTarget = path.resolve(base, target);
    const parsedTarget = path.parse(resolvedTarget);
    const targetRoot = parsedTarget.root || path.sep;
    const targetSegments = resolvedTarget
      .slice(targetRoot.length)
      .split(path.sep)
      .filter((segment) => segment.length > 0);
    return resolveSegments(targetRoot, [], [...targetSegments, ...rest]);
  }

  return resolveSegments(root, [...resolved, next], rest);
}

function joinPath(root: string, segments: readonly string[]): string {
  if (segments.length === 0) return root;
  return path.join(root, ...segments);
}

function expandHome(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, input.slice(1));
  }
  return input;
}
