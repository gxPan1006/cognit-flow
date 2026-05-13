import { defaultClient, type LinearClient } from "../../linear/client.js";

/**
 * Executes client-side tool calls requested by Codex app-server turns.
 *  (209 LOC).
 */

const LINEAR_GRAPHQL_TOOL = "linear_graphql";
const LINEAR_GRAPHQL_DESCRIPTION =
  "Execute a raw GraphQL query or mutation against Linear using Cognit Flow's configured auth.";

const LINEAR_GRAPHQL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "GraphQL query or mutation document to execute against Linear.",
    },
    variables: {
      type: ["object", "null"],
      description: "Optional GraphQL variables object.",
      additionalProperties: true,
    },
  },
};

export interface DynamicToolResult {
  success: boolean;
  output: string;
  contentItems: Array<{ type: "inputText"; text: string }>;
}

export interface DynamicToolExecutor {
  execute(tool: string | null, args: unknown): Promise<DynamicToolResult>;
  toolSpecs(): Array<Record<string, unknown>>;
}

export function defaultDynamicTool(client: LinearClient = defaultClient()): DynamicToolExecutor {
  return {
    toolSpecs() {
      return [
        {
          name: LINEAR_GRAPHQL_TOOL,
          description: LINEAR_GRAPHQL_DESCRIPTION,
          inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA,
        },
      ];
    },

    async execute(tool, args) {
      if (tool === LINEAR_GRAPHQL_TOOL) {
        return executeLinearGraphql(args, client);
      }
      return failureResponse({
        error: {
          message: `Unsupported dynamic tool: ${JSON.stringify(tool)}`,
          supportedTools: [LINEAR_GRAPHQL_TOOL],
        },
      });
    },
  };
}

async function executeLinearGraphql(
  args: unknown,
  client: LinearClient,
): Promise<DynamicToolResult> {
  const parsed = parseLinearGraphqlArgs(args);
  if (!parsed.ok) {
    return failureResponse(errorPayloadFor(parsed.error));
  }
  const result = await client.graphql<unknown>(parsed.value.query, parsed.value.variables);
  if (!result.ok) {
    return failureResponse(errorPayloadFor(result.error));
  }
  return graphqlResponse(result.value);
}

type ParseResult =
  | { ok: true; value: { query: string; variables: Record<string, unknown> } }
  | { ok: false; error: string };

function parseLinearGraphqlArgs(args: unknown): ParseResult {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed === "") return { ok: false, error: "missing_query" };
    return { ok: true, value: { query: trimmed, variables: {} } };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "invalid_arguments" };
  }
  const rec = args as Record<string, unknown>;
  const queryRaw = rec.query;
  if (typeof queryRaw !== "string" || queryRaw.trim() === "") {
    return { ok: false, error: "missing_query" };
  }
  const variablesRaw = rec.variables ?? {};
  if (typeof variablesRaw !== "object" || variablesRaw === null || Array.isArray(variablesRaw)) {
    return { ok: false, error: "invalid_variables" };
  }
  return { ok: true, value: { query: queryRaw.trim(), variables: variablesRaw as Record<string, unknown> } };
}

function graphqlResponse(response: unknown): DynamicToolResult {
  const success = !hasErrors(response);
  return wrapResponse(success, encodePayload(response));
}

function hasErrors(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const errors = (response as Record<string, unknown>).errors;
  return Array.isArray(errors) && errors.length > 0;
}

function failureResponse(payload: unknown): DynamicToolResult {
  return wrapResponse(false, encodePayload(payload));
}

function wrapResponse(success: boolean, output: string): DynamicToolResult {
  return {
    success,
    output,
    contentItems: [{ type: "inputText", text: output }],
  };
}

function encodePayload(value: unknown): string {
  if (value && (typeof value === "object" || Array.isArray(value))) {
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value);
}

function errorPayloadFor(reason: unknown): Record<string, unknown> {
  if (typeof reason === "string") {
    switch (reason) {
      case "missing_query":
        return { error: { message: "`linear_graphql` requires a non-empty `query` string." } };
      case "invalid_arguments":
        return {
          error: {
            message:
              "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
          },
        };
      case "invalid_variables":
        return {
          error: { message: "`linear_graphql.variables` must be a JSON object when provided." },
        };
    }
  }
  if (reason && typeof reason === "object" && "kind" in reason) {
    const r = reason as { kind: string; status?: number; cause?: unknown };
    if (r.kind === "missing_linear_api_token") {
      return {
        error: {
          message:
            "Cognit Flow is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      };
    }
    if (r.kind === "linear_api_status") {
      return {
        error: { message: `Linear GraphQL request failed with HTTP ${r.status}.`, status: r.status },
      };
    }
    if (r.kind === "linear_api_request") {
      return {
        error: {
          message: "Linear GraphQL request failed before receiving a successful response.",
          reason: String(r.cause),
        },
      };
    }
  }
  return { error: { message: "Linear GraphQL tool execution failed.", reason: JSON.stringify(reason) } };
}

export { LINEAR_GRAPHQL_TOOL };
