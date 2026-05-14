import { load } from "../workflow/loader.js";
import { workflowStore } from "../workflow/store.js";
import {
  parse,
  resolveRuntimeTurnSandboxPolicy,
  type Settings,
  type SandboxPolicyResult,
} from "./schema.js";

/**
 * High-level runtime configuration accessors.
 *  — wraps Workflow loader + Schema.parse and applies
 * runtime overrides for port / language.
 */

export interface CognitFlowRuntimeEnv {
  language?: string | null;
  serverPortOverride?: number | null;
}

const env: CognitFlowRuntimeEnv = {};

export function setLanguage(value: string | null): void {
  env.language = value;
}

export function language(): string | null {
  const v = env.language;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function setServerPortOverride(value: number | null): void {
  env.serverPortOverride = value;
}

export type SettingsResult =
  | { ok: true; value: Settings }
  | { ok: false; error: unknown };

/**
 * Return parsed Settings, reading from the workflow store if running, otherwise
 * doing a one-shot load. /0.
 */
export async function settings(): Promise<SettingsResult> {
  const cached = workflowStore.current();
  if (cached) {
    return parse(cached.config);
  }
  const loaded = await load();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return parse(loaded.value.config);
}

export async function settingsOrThrow(): Promise<Settings> {
  const result = await settings();
  if (!result.ok) {
    throw new Error(`Invalid WORKFLOW.md config: ${formatError(result.error)}`);
  }
  return result.value;
}

export async function maxConcurrentAgentsForState(stateName: string): Promise<number> {
  const s = await settingsOrThrow();
  const normalized = stateName.toLowerCase();
  return s.agent.max_concurrent_agents_by_state[normalized] ?? s.agent.max_concurrent_agents;
}

export async function codexTurnSandboxPolicy(
  workspace?: string,
): Promise<Record<string, unknown>> {
  const s = await settingsOrThrow();
  const result: SandboxPolicyResult = resolveRuntimeTurnSandboxPolicy(s, workspace);
  if (!result.ok) {
    throw new Error(`Invalid codex turn sandbox policy: ${JSON.stringify(result.error)}`);
  }
  return result.policy;
}

export async function codingToolKind(): Promise<string> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind || "codex";
}

export async function activeToolTurnTimeoutMs(): Promise<number> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind === "claude"
    ? s.claude.turn_timeout_ms
    : s.codex.turn_timeout_ms;
}

export async function activeToolStallTimeoutMs(): Promise<number> {
  const s = await settingsOrThrow();
  return s.coding_tool.kind === "claude"
    ? s.claude.stall_timeout_ms
    : s.codex.stall_timeout_ms;
}

export async function serverPort(): Promise<number | null> {
  const override = env.serverPortOverride;
  if (typeof override === "number" && override >= 0) return override;
  const s = await settingsOrThrow();
  return s.server.port ?? null;
}

const DEFAULT_PROMPT_TEMPLATE = `You are an autonomous coding agent. Cognit Flow has dispatched you a tracker issue and provisioned an isolated workspace (your shell's current working directory) to resolve it in.

Identifier: {{ issue.identifier }}
Issue ID (use this for tracker API calls): {{ issue.id }}
Title: {{ issue.title }}
Current state: {{ issue.state }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

{% if attempt %}
## Continuation context — retry attempt #{{ attempt }}

The issue is still in an active state, so this is a continuation, not a fresh start.

- First run "git status --short --branch" and "git log --oneline -5". If your branch already has commits or uncommitted changes, resume from there — do NOT restart from scratch.
- Do not repeat finished investigation or validation unless new code changes require it.
- Do not end the turn while the issue is still in an active state, unless blocked by a true external blocker (missing required auth, permissions, or secrets).
{% endif %}

## Operating rules

1. This is an unattended run. Never ask a human to do follow-up actions; never wait for human input.
2. Stop early ONLY for a true blocker — missing required auth/permissions/secrets, or a decision that genuinely cannot be made without the repo owner. When blocked, record it in the workpad and move the issue to the review state with a concise blocker brief (see Blocker escape hatch).
3. Work ONLY inside this workspace directory. Never touch any other path on the machine.
4. Your final message reports completed actions and blockers only — no "next steps for the user".

## Talking to the tracker (Linear)

Use whichever is available, in this order:

1. A linear_graphql tool, if one is present in your runtime — pass it a GraphQL query and variables directly.
2. Otherwise the LINEAR_API_KEY environment variable is inherited into your shell — call the API directly:

       curl -sS -X POST https://api.linear.app/graphql \\
         -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \\
         -d '{"query":"<graphql>","variables":{<vars>}}'

Do not use external tracker MCP/app tools even if they appear available — their write calls can hang unattended runs. If a query or mutation fails, use GraphQL introspection through the same path to fix the shape and retry.

Linear cheat sheet (issue id = {{ issue.id }}):

- Read this issue's state:

      query($id:String!){ issue(id:$id){ identifier state{name} url } }

- Move this issue to a new state — first resolve the target state id for this issue's team, then update:

      query($id:String!,$name:String!){ issue(id:$id){ team{ states(filter:{name:{eq:$name}},first:1){ nodes{id} } } } }
      mutation($id:String!,$s:String!){ issueUpdate(id:$id,input:{stateId:$s}){ success } }

- Workpad comment — create once, then update in place:

      mutation($id:String!,$b:String!){ commentCreate(input:{issueId:$id,body:$b}){ success comment{id} } }
      mutation($cid:String!,$b:String!){ commentUpdate(id:$cid,input:{body:$b}){ success } }

- Attach the PR to the issue:

      mutation($id:String!,$u:String!,$t:String!){ attachmentLinkURL(issueId:$id,url:$u,title:$t){ success } }

## Git / hosted-upstream topology — read before any git work

This workspace was created by git clone, but its "origin" may point at a local mirror rather than the hosted repo (GitHub/GitLab/etc.). Before branching:

1. Run "git remote -v" and identify the hosted upstream (an https:// or git@host: URL). If only a local-path origin exists, add the hosted remote yourself — read it from the project's config, or, if it is genuinely unknown, ask once via the workpad.
2. Fetch the hosted remote and base your work on its default branch (usually main): git switch -c <branch> <hosted-remote>/main
3. Branch name: <issue-identifier>-<short-kebab-summary>

The local mirror's branches may have drifted from the hosted repo — the hosted default branch is the source of truth for branching, rebasing, and the PR base.

## Status map

Tracker state names may vary slightly per project; treat them by role:

- Todo / queued → immediately move to In Progress, then start work.
- In Progress → implementation underway; resume from the workpad.
- Merging → a human approved the PR; merge it (Merging flow).
- Rework → a reviewer requested changes; do a fresh planning + implementation pass on the existing branch/PR (Rework flow).
- Human Review (or equivalent) and terminal states → not your job. Stop, do nothing.

## Step 0 — Route by current state

1. Read the issue's current state.
2. Route: Todo → move to In Progress, then Step 1. In Progress → Step 1 (resume). Merging → Merging flow. Rework → Rework flow. Review/terminal → stop.

## Step 1 — Workpad

Maintain exactly ONE persistent tracker comment as your workpad. Marker header: "## Cognit Flow Workpad".

- Search this issue's comments for that header. Reuse it if found; create it once if not. Remember the comment id; only ever update that one comment.
- The workpad holds: an environment stamp line (hostname:abs-workspace-path@short-sha), a Plan checklist, an Acceptance Criteria checklist, a Validation checklist, and a Notes section.
- If the issue description has a Validation / Test Plan / Testing section, copy it into Acceptance Criteria / Validation as required (non-optional) checkboxes.
- Update the workpad after each meaningful milestone. Never leave finished work unchecked.

## Step 2 — Implement

1. Confirm branch, git status, and base.
2. Reproduce or confirm the current behavior first so the change target is explicit; note it in the workpad.
3. Implement against the plan. Match the surrounding code's style, naming, and conventions.
4. Honor the project's own conventions — read its README, CLAUDE.md / AGENTS.md, and contributing docs, including changelog, commit-message, and test conventions.
5. Run validation for your scope — the project's tests, type-checks, and linters. Execute every issue-provided validation item; treat unmet items as incomplete work.
6. Commit with a clear message that references the issue identifier.

## Step 3 — Publish and hand off

1. Push your branch to the hosted remote.
2. Open a PR against the hosted default branch (use gh for GitHub, or the host's equivalent). PR body: summary, changes, verification.
3. Attach the PR URL to the tracker issue.
4. Update the workpad — check off completed items, add the final validation summary.
5. Move the issue to the review state (e.g. Human Review).

## Completion bar — all must hold before the review state

- Plan, acceptance criteria, and validation in the workpad are complete and checked.
- Validation/tests are green on the latest commit.
- The branch is pushed to the hosted remote and a PR is open and attached to the issue.
- Exception: the Blocker escape hatch below.

## Merging flow — issue in Merging

A human approved the PR. Resolve any conflicts against the hosted default branch first, then merge it using the host's CLI. After the merge succeeds, move the issue to a terminal Done state.

## Rework flow — issue in Rework

A reviewer requested changes. Re-read the full issue and all PR review comments. Treat every actionable comment as blocking until it is addressed in code or answered with justified pushback. Update the workpad plan, implement, re-validate, push, then move the issue back to the review state.

## Blocker escape hatch

Use ONLY for a true blocker: missing required auth/permissions/secrets, or a decision that genuinely needs the repo owner. Exhaust reasonable fallbacks first. When genuinely blocked: write a concise blocker brief in the workpad (what is missing, why it blocks acceptance, the exact human action needed), move the issue to the review state, and stop.

## Guardrails

- Never touch files outside this workspace.
- Use exactly one workpad comment per issue; never spam extra comments.
- Do not edit the issue title/description for progress tracking — that is what the workpad is for.
- Move issue state only when the matching bar is met.
- If the issue is in a backlog or terminal state, do nothing.
`;

/**
 * The effective prompt template — workflow body if present, otherwise the
 * built-in minimal default. Mirrors Config.workflow_prompt/0.
 */
export async function workflowPrompt(): Promise<string> {
  const cached = workflowStore.current();
  const tmpl = cached?.promptTemplate;
  if (typeof tmpl === "string" && tmpl.trim() !== "") return tmpl;

  const loaded = await load();
  if (loaded.ok && loaded.value.promptTemplate.trim() !== "") {
    return loaded.value.promptTemplate;
  }
  return DEFAULT_PROMPT_TEMPLATE;
}

export type ValidationError =
  | { kind: "missing_tracker_kind" }
  | { kind: "unsupported_tracker_kind"; value: string }
  | { kind: "missing_linear_api_token" }
  | { kind: "missing_linear_project_slug" }
  | { kind: "unsupported_coding_tool"; value: string };

export async function validateSemantics(): Promise<{ ok: true } | { ok: false; error: ValidationError }> {
  const s = await settingsOrThrow();
  if (!s.tracker.kind) return { ok: false, error: { kind: "missing_tracker_kind" } };
  if (s.tracker.kind !== "linear" && s.tracker.kind !== "memory") {
    return { ok: false, error: { kind: "unsupported_tracker_kind", value: s.tracker.kind } };
  }
  if (s.tracker.kind === "linear" && typeof s.tracker.api_key !== "string") {
    return { ok: false, error: { kind: "missing_linear_api_token" } };
  }
  if (s.tracker.kind === "linear" && typeof s.tracker.project_slug !== "string") {
    return { ok: false, error: { kind: "missing_linear_project_slug" } };
  }
  if (s.coding_tool.kind !== "codex" && s.coding_tool.kind !== "claude") {
    return { ok: false, error: { kind: "unsupported_coding_tool", value: s.coding_tool.kind } };
  }
  return { ok: true };
}

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; message?: string; path?: string };
    if (e.kind === "missing_workflow_file" && e.path) {
      return `Missing WORKFLOW.md at ${e.path}`;
    }
    if (e.kind === "invalid_workflow_config" && e.message) {
      return e.message;
    }
  }
  return JSON.stringify(error);
}
