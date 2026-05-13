/**
 * Public entrypoint — re-exports the surfaces a programmatic caller would use.
 * Public entrypoint for programmatic use.
 */
export { main as runCli } from "./cli.js";
export * as config from "./config/index.js";
export * as workflow from "./workflow/loader.js";
export * as linear from "./linear/client.js";
export * as linearAdapter from "./linear/adapter.js";
export type { Issue, BlockedByRef } from "./linear/issue.js";
export { buildPrompt } from "./prompt-builder.js";
