import { defaultClient, type LinearClient, type LinearResult } from "./client.js";
import type { Issue } from "./issue.js";

/**
 * Linear-backed tracker adapter — fetch + mutation surface used by the
 * orchestrator.  The client is pluggable for
 * tests.
 */

const CREATE_COMMENT_MUTATION = `
mutation CognitFlowCreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
  }
}
`.trim();

const UPDATE_STATE_MUTATION = `
mutation CognitFlowUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) {
    success
  }
}
`.trim();

const STATE_LOOKUP_QUERY = `
query CognitFlowResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) {
    team {
      states(filter: {name: {eq: $stateName}}, first: 1) {
        nodes { id }
      }
    }
  }
}
`.trim();

export interface LinearAdapter {
  fetchCandidateIssues(): Promise<LinearResult<Issue[]>>;
  fetchIssuesByStates(stateNames: string[]): Promise<LinearResult<Issue[]>>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<LinearResult<Issue[]>>;
  createComment(issueId: string, body: string): Promise<LinearResult<void>>;
  updateIssueState(issueId: string, stateName: string): Promise<LinearResult<void>>;
}

export function makeAdapter(client: LinearClient = defaultClient()): LinearAdapter {
  return {
    fetchCandidateIssues: () => client.fetchCandidateIssues(),
    fetchIssuesByStates: (states) => client.fetchIssuesByStates(states),
    fetchIssueStatesByIds: (ids) => client.fetchIssueStatesByIds(ids),

    async createComment(issueId, body) {
      const result = await client.graphql<{
        data?: { commentCreate?: { success?: boolean } };
      }>(CREATE_COMMENT_MUTATION, { issueId, body });
      if (!result.ok) return result;
      if (result.value?.data?.commentCreate?.success === true) {
        return { ok: true, value: undefined };
      }
      return { ok: false, error: { kind: "linear_api_request", cause: "comment_create_failed" } };
    },

    async updateIssueState(issueId, stateName) {
      const lookup = await client.graphql<{
        data?: { issue?: { team?: { states?: { nodes?: Array<{ id?: string }> } } } };
      }>(STATE_LOOKUP_QUERY, { issueId, stateName });
      if (!lookup.ok) return lookup;
      const stateId = lookup.value?.data?.issue?.team?.states?.nodes?.[0]?.id;
      if (typeof stateId !== "string") {
        return { ok: false, error: { kind: "linear_api_request", cause: "state_not_found" } };
      }

      const update = await client.graphql<{
        data?: { issueUpdate?: { success?: boolean } };
      }>(UPDATE_STATE_MUTATION, { issueId, stateId });
      if (!update.ok) return update;
      if (update.value?.data?.issueUpdate?.success === true) {
        return { ok: true, value: undefined };
      }
      return { ok: false, error: { kind: "linear_api_request", cause: "issue_update_failed" } };
    },
  };
}
