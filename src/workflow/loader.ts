import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";

export interface LoadedWorkflow {
  config: Record<string, unknown>;
  prompt: string;
  promptTemplate: string;
}

export type WorkflowLoadError =
  | { kind: "missing_workflow_file"; path: string; cause: unknown }
  | { kind: "workflow_parse_error"; cause: unknown }
  | { kind: "workflow_front_matter_not_a_map" };

export type WorkflowLoadResult =
  | { ok: true; value: LoadedWorkflow }
  | { ok: false; error: WorkflowLoadError };

const WORKFLOW_FILE_NAME = "WORKFLOW.md";

let workflowFilePathOverride: string | null = null;

export function workflowFilePath(): string {
  return workflowFilePathOverride ?? path.join(process.cwd(), WORKFLOW_FILE_NAME);
}

export function setWorkflowFilePath(p: string): void {
  workflowFilePathOverride = p;
}

export function clearWorkflowFilePath(): void {
  workflowFilePathOverride = null;
}

/**
 * Load and parse WORKFLOW.md from the configured path (or argument).
 * /{0,1}.
 */
export async function load(filePath: string = workflowFilePath()): Promise<WorkflowLoadResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: { kind: "missing_workflow_file", path: filePath, cause: err },
    };
  }
  return parse(content);
}

export function parse(content: string): WorkflowLoadResult {
  const { frontMatter, promptLines } = splitFrontMatter(content);

  let config: Record<string, unknown>;
  try {
    config = parseFrontMatter(frontMatter);
  } catch (err) {
    if (err instanceof FrontMatterNotMapError) {
      return { ok: false, error: { kind: "workflow_front_matter_not_a_map" } };
    }
    return { ok: false, error: { kind: "workflow_parse_error", cause: err } };
  }

  const prompt = promptLines.join("\n").trim();

  return {
    ok: true,
    value: {
      config,
      prompt,
      promptTemplate: prompt,
    },
  };
}

function splitFrontMatter(content: string): {
  frontMatter: string[];
  promptLines: string[];
} {
  // Normalize all newlines; preserve empty trailing lines (matching Elixir's
  // String.split(content, ~r/\R/u, trim: false)).
  const lines = content.split(/\r\n|\r|\n/);

  if (lines[0] !== "---") {
    return { frontMatter: [], promptLines: lines };
  }

  const tail = lines.slice(1);
  const closeIdx = tail.indexOf("---");
  if (closeIdx === -1) {
    return { frontMatter: tail, promptLines: [] };
  }
  return {
    frontMatter: tail.slice(0, closeIdx),
    promptLines: tail.slice(closeIdx + 1),
  };
}

class FrontMatterNotMapError extends Error {}

function parseFrontMatter(lines: readonly string[]): Record<string, unknown> {
  const text = lines.join("\n");
  if (text.trim() === "") return {};
  const parsed = yaml.load(text);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontMatterNotMapError();
  }
  return parsed as Record<string, unknown>;
}
