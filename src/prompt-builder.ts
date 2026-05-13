import { Liquid } from "liquidjs";
import { language, workflowPrompt } from "./config/index.js";
import type { Issue } from "./linear/issue.js";

/**
 * Renders the workflow prompt for a given issue.
 * /2 — strict variables + strict
 * filters (unknown vars/filters fail the render).
 */

let engine: Liquid | null = null;

function getEngine(): Liquid {
  if (!engine) {
    engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
      lenientIf: false,
    });
  }
  return engine;
}

export interface BuildPromptOpts {
  attempt?: number | null;
}

export async function buildPrompt(issue: Issue, opts: BuildPromptOpts = {}): Promise<string> {
  const template = await workflowPrompt();
  const parsed = await tryParse(template);

  const context = {
    attempt: opts.attempt ?? null,
    language: language(),
    issue: issueToLiquidContext(issue),
  };

  return getEngine().render(parsed, context);
}

async function tryParse(template: string) {
  try {
    return getEngine().parse(template);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`template_parse_error: ${message} template=${JSON.stringify(template)}`);
  }
}

/**
 * Convert an Issue to the snake_case-keyed shape that WORKFLOW.md templates expect.
 * Elixir's PromptBuilder uses Map.from_struct/1 with struct keys; here we mirror
 * those keys explicitly so existing templates render unchanged.
 */
function issueToLiquidContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    assigned_to_worker: issue.assignedToWorker,
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}
