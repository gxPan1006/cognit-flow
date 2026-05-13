import { settingsOrThrow } from "../config/index.js";
import { logger } from "../log-file.js";
import { makeIssue, type BlockedByRef, type Issue } from "./issue.js";

/**
 * Thin Linear GraphQL client.  (586 LOC).
 * Uses raw GraphQL (not @linear/sdk) because we want exact parity with the
 * Elixir queries and pagination behavior.
 */

const ISSUE_PAGE_SIZE = 50;
const MAX_ERROR_BODY_LOG_BYTES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

const POLL_QUERY = `
query CognitFlowLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();

const QUERY_BY_IDS = `
query CognitFlowLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt updatedAt
    }
  }
}
`.trim();

const VIEWER_QUERY = `
query CognitFlowLinearViewer { viewer { id } }
`.trim();

export type LinearError =
  | { kind: "missing_linear_api_token" }
  | { kind: "missing_linear_project_slug" }
  | { kind: "missing_linear_viewer_identity" }
  | { kind: "linear_missing_end_cursor" }
  | { kind: "linear_unknown_payload" }
  | { kind: "linear_graphql_errors"; errors: unknown }
  | { kind: "linear_api_status"; status: number }
  | { kind: "linear_api_request"; cause: unknown };

export type LinearResult<T> = { ok: true; value: T } | { ok: false; error: LinearError };

interface AssigneeFilter {
  configuredAssignee: string;
  matchValues: Set<string>;
}

export interface LinearClient {
  fetchCandidateIssues(): Promise<LinearResult<Issue[]>>;
  fetchIssuesByStates(stateNames: string[]): Promise<LinearResult<Issue[]>>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<LinearResult<Issue[]>>;
  graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    opts?: { operationName?: string },
  ): Promise<LinearResult<T>>;
}

export function defaultClient(): LinearClient {
  return new HttpLinearClient();
}

class HttpLinearClient implements LinearClient {
  async fetchCandidateIssues(): Promise<LinearResult<Issue[]>> {
    const s = await settingsOrThrow();
    const tracker = s.tracker;
    if (!tracker.api_key) return { ok: false, error: { kind: "missing_linear_api_token" } };
    if (!tracker.project_slug)
      return { ok: false, error: { kind: "missing_linear_project_slug" } };

    const filter = await this.#routingAssigneeFilter();
    if (!filter.ok) return filter;

    return this.#fetchByStates(tracker.project_slug, tracker.active_states, filter.value);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<LinearResult<Issue[]>> {
    const normalized = Array.from(new Set(stateNames.map((n) => String(n))));
    if (normalized.length === 0) return { ok: true, value: [] };

    const s = await settingsOrThrow();
    const tracker = s.tracker;
    if (!tracker.api_key) return { ok: false, error: { kind: "missing_linear_api_token" } };
    if (!tracker.project_slug)
      return { ok: false, error: { kind: "missing_linear_project_slug" } };

    return this.#fetchByStates(tracker.project_slug, normalized, null);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<LinearResult<Issue[]>> {
    const ids = Array.from(new Set(issueIds));
    if (ids.length === 0) return { ok: true, value: [] };

    const filter = await this.#routingAssigneeFilter();
    if (!filter.ok) return filter;

    return this.#fetchIssueStatesPaginated(ids, filter.value);
  }

  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { operationName?: string } = {},
  ): Promise<LinearResult<T>> {
    const s = await settingsOrThrow();
    const token = s.tracker.api_key;
    if (!token) return { ok: false, error: { kind: "missing_linear_api_token" } };

    const payload: Record<string, unknown> = { query, variables };
    if (opts.operationName && opts.operationName.trim() !== "") {
      payload.operationName = opts.operationName.trim();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(s.tracker.endpoint, {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status !== 200) {
        const body = await safeText(response);
        logger().error(
          { status: response.status, body: summarizeErrorBody(body), operation: opts.operationName },
          "Linear GraphQL request failed",
        );
        return { ok: false, error: { kind: "linear_api_status", status: response.status } };
      }

      const body = (await response.json()) as T;
      return { ok: true, value: body };
    } catch (err) {
      logger().error({ err }, "Linear GraphQL request failed");
      return { ok: false, error: { kind: "linear_api_request", cause: err } };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- pagination ----

  async #fetchByStates(
    projectSlug: string,
    stateNames: readonly string[],
    assigneeFilter: AssigneeFilter | null,
  ): Promise<LinearResult<Issue[]>> {
    const collected: Issue[][] = [];
    let after: string | null = null;
    while (true) {
      const result = await this.graphql<LinearPageResponse>(POLL_QUERY, {
        projectSlug,
        stateNames,
        first: ISSUE_PAGE_SIZE,
        relationFirst: ISSUE_PAGE_SIZE,
        after,
      });
      if (!result.ok) return result;

      const decoded = decodeLinearPageResponse(result.value, assigneeFilter);
      if (!decoded.ok) return decoded;

      collected.push(decoded.value.issues);
      const next = nextPageCursor(decoded.value.pageInfo);
      if (next.kind === "done") {
        return { ok: true, value: collected.flat() };
      }
      if (next.kind === "error") return { ok: false, error: next.error };
      after = next.cursor;
    }
  }

  async #fetchIssueStatesPaginated(
    ids: string[],
    assigneeFilter: AssigneeFilter | null,
  ): Promise<LinearResult<Issue[]>> {
    const orderIndex = new Map(ids.map((id, idx) => [id, idx] as const));
    const collected: Issue[] = [];
    let remaining = ids;
    while (remaining.length > 0) {
      const batch = remaining.slice(0, ISSUE_PAGE_SIZE);
      remaining = remaining.slice(ISSUE_PAGE_SIZE);

      const result = await this.graphql<LinearListResponse>(QUERY_BY_IDS, {
        ids: batch,
        first: batch.length,
        relationFirst: ISSUE_PAGE_SIZE,
      });
      if (!result.ok) return result;

      const decoded = decodeLinearResponse(result.value, assigneeFilter);
      if (!decoded.ok) return decoded;
      collected.push(...decoded.value);
    }

    const fallback = orderIndex.size;
    collected.sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? fallback;
      const bi = orderIndex.get(b.id) ?? fallback;
      return ai - bi;
    });
    return { ok: true, value: collected };
  }

  async #routingAssigneeFilter(): Promise<LinearResult<AssigneeFilter | null>> {
    const s = await settingsOrThrow();
    const assignee = s.tracker.assignee;
    if (!assignee) return { ok: true, value: null };

    const normalized = normalizeAssigneeMatchValue(assignee);
    if (normalized === null) return { ok: true, value: null };
    if (normalized === "me") return this.#resolveViewerAssigneeFilter();
    return {
      ok: true,
      value: { configuredAssignee: assignee, matchValues: new Set([normalized]) },
    };
  }

  async #resolveViewerAssigneeFilter(): Promise<LinearResult<AssigneeFilter | null>> {
    const result = await this.graphql<ViewerResponse>(VIEWER_QUERY);
    if (!result.ok) return result;
    const viewerId = result.value?.data?.viewer?.id;
    if (typeof viewerId !== "string" || viewerId === "") {
      return { ok: false, error: { kind: "missing_linear_viewer_identity" } };
    }
    return {
      ok: true,
      value: { configuredAssignee: "me", matchValues: new Set([viewerId]) },
    };
  }
}

// ---- response decoders ----

interface LinearListResponse {
  data?: { issues?: { nodes?: RawIssue[] } };
  errors?: unknown;
}
interface LinearPageResponse {
  data?: {
    issues?: {
      nodes?: RawIssue[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: unknown;
}
interface ViewerResponse {
  data?: { viewer?: { id?: string } };
}

interface RawIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  priority?: number | null;
  state?: { name?: string };
  branchName?: string | null;
  url?: string | null;
  assignee?: { id?: string } | null;
  labels?: { nodes?: Array<{ name?: string | null }> };
  inverseRelations?: {
    nodes?: Array<{
      type?: string;
      issue?: { id?: string; identifier?: string; state?: { name?: string } };
    }>;
  };
  createdAt?: string;
  updatedAt?: string;
}

function decodeLinearResponse(
  body: LinearListResponse,
  assigneeFilter: AssigneeFilter | null,
): LinearResult<Issue[]> {
  if (body.errors) return { ok: false, error: { kind: "linear_graphql_errors", errors: body.errors } };
  const nodes = body.data?.issues?.nodes;
  if (!Array.isArray(nodes)) return { ok: false, error: { kind: "linear_unknown_payload" } };
  const issues = nodes
    .map((node) => normalizeIssue(node, assigneeFilter))
    .filter((i): i is Issue => i !== null);
  return { ok: true, value: issues };
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function decodeLinearPageResponse(
  body: LinearPageResponse,
  assigneeFilter: AssigneeFilter | null,
): LinearResult<{ issues: Issue[]; pageInfo: PageInfo }> {
  if (body.errors) return { ok: false, error: { kind: "linear_graphql_errors", errors: body.errors } };
  const issuesField = body.data?.issues;
  const nodes = issuesField?.nodes;
  const pageInfo = issuesField?.pageInfo;
  if (!Array.isArray(nodes) || !pageInfo) {
    // Fall back to flat decode for compatibility
    return decodeLinearResponse(body, assigneeFilter).ok
      ? {
          ok: true,
          value: {
            issues: (decodeLinearResponse(body, assigneeFilter) as { ok: true; value: Issue[] }).value,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      : { ok: false, error: { kind: "linear_unknown_payload" } };
  }
  const issues = nodes
    .map((node) => normalizeIssue(node, assigneeFilter))
    .filter((i): i is Issue => i !== null);
  return {
    ok: true,
    value: {
      issues,
      pageInfo: {
        hasNextPage: pageInfo.hasNextPage === true,
        endCursor: pageInfo.endCursor ?? null,
      },
    },
  };
}

type NextCursor =
  | { kind: "next"; cursor: string }
  | { kind: "done" }
  | { kind: "error"; error: LinearError };

function nextPageCursor(pageInfo: PageInfo): NextCursor {
  if (pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0) {
    return { kind: "next", cursor: pageInfo.endCursor };
  }
  if (pageInfo.hasNextPage) {
    return { kind: "error", error: { kind: "linear_missing_end_cursor" } };
  }
  return { kind: "done" };
}

function normalizeIssue(raw: RawIssue, assigneeFilter: AssigneeFilter | null): Issue | null {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id || !raw.identifier || !raw.title || !raw.state?.name) return null;

  const assigneeId =
    raw.assignee && typeof raw.assignee === "object" && typeof raw.assignee.id === "string"
      ? raw.assignee.id
      : null;

  return makeIssue({
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    priority: typeof raw.priority === "number" ? raw.priority : null,
    state: raw.state.name,
    branchName: raw.branchName ?? null,
    url: raw.url ?? null,
    assigneeId,
    blockedBy: extractBlockers(raw),
    labels: extractLabels(raw),
    assignedToWorker: isAssignedToWorker(assigneeId, assigneeFilter),
    createdAt: parseDate(raw.createdAt),
    updatedAt: parseDate(raw.updatedAt),
  });
}

function isAssignedToWorker(assigneeId: string | null, filter: AssigneeFilter | null): boolean {
  if (!filter) return true;
  if (!assigneeId) return false;
  return filter.matchValues.has(assigneeId);
}

function extractLabels(raw: RawIssue): string[] {
  const nodes = raw.labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => node?.name)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.toLowerCase());
}

function extractBlockers(raw: RawIssue): BlockedByRef[] {
  const nodes = raw.inverseRelations?.nodes;
  if (!Array.isArray(nodes)) return [];
  const result: BlockedByRef[] = [];
  for (const node of nodes) {
    if (!node) continue;
    const type = typeof node.type === "string" ? node.type.trim().toLowerCase() : "";
    if (type !== "blocks") continue;
    const blocker = node.issue;
    if (!blocker || typeof blocker !== "object") continue;
    result.push({
      id: blocker.id ?? null,
      identifier: blocker.identifier ?? null,
      state: blocker.state?.name ?? null,
    });
  }
  return result;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeAssigneeMatchValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function summarizeErrorBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length > MAX_ERROR_BODY_LOG_BYTES) {
    return collapsed.slice(0, MAX_ERROR_BODY_LOG_BYTES) + "...<truncated>";
  }
  return collapsed;
}
