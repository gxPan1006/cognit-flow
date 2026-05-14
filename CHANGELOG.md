# Changelog

All notable changes to **Cognit Flow** will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `DEFAULT_PROMPT_TEMPLATE` is now a full project-agnostic lifecycle workflow
  prompt instead of a 6-line stub. The old default only stated the issue
  identifier/title/body and gave the agent no instructions — no tracker state
  transitions, no tracker access, no commit/push/PR steps, no completion bar —
  so control-plane-generated `WORKFLOW.md` files (which embed this default) and
  the runtime fallback both produced agents that could not drive Cognit Flow's
  own issue lifecycle. The new default covers routing by state, the workpad
  comment protocol, tracker access (`linear_graphql` tool or `LINEAR_API_KEY`),
  hosted-upstream git topology, implement/publish steps, Merging/Rework flows,
  the completion bar, and the blocker escape hatch — with no hardcoded
  project/repo/port specifics.

## [0.1.0] — 2026-05-13

Initial public release. Behavior-equivalent TypeScript implementation of the
[`gxPan1006/cognition-orchestrator`](https://github.com/gxPan1006/cognition-orchestrator)
Elixir reference; same `WORKFLOW.md` contract, same Linear / Claude Code /
Codex integrations.

### Added

#### Orchestration core
- `Orchestrator` class with tick loop, eligibility checks, retry queue, and
  reconciliation against the upstream tracker.
- Per-state and global concurrency gates (`agent.max_concurrent_agents`,
  `agent.max_concurrent_agents_by_state`).
- Continuation-retry (1s) on normal completion when the issue is still active,
  exponential-backoff retry on agent failure (10s base, doubling, capped at
  `agent.max_retry_backoff_ms`).
- Workspace reconciliation: agents on issues that move to terminal / non-active
  states are stopped and their workspaces cleaned up.

#### Coding-tool adapters
- **Claude Code CLI** adapter — parses `stream-json` output, tracks cumulative
  usage tokens, remembers `session_id` for `--resume` on subsequent turns.
- **OpenAI Codex CLI** adapter — full JSON-RPC over stdio: `initialize` →
  `thread/start` → `turn/start` → receive loop with approval auto-accept and
  dynamic tool execution.
- `linear_graphql` dynamic tool exposed to Codex agents so they can mutate
  Linear from inside the sandbox.

#### Workspace management
- Per-issue workspaces under `workspace.root`, sanitized identifier as the dir
  name.
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`,
  `before_remove`) executed via `bash -lc` with `hooks.timeout_ms`.
- Path-canonicalization guard against symlink escapes outside `workspace.root`.

#### Linear integration
- Raw GraphQL client (no `@linear/sdk` dependency for behavior parity with the
  upstream Elixir client).
- Pagination, state-name filtering, `inverseRelations` blockers extraction,
  assignee filter (literal id or `me`).
- Adapter surface: `fetchCandidateIssues`, `fetchIssuesByStates`,
  `fetchIssueStatesByIds`, `createComment`, `updateIssueState`.

#### Observability
- Real-time HTTP dashboard at `/` (server-rendered HTML + Server-Sent Events,
  no client framework).
- JSON API at `/api/snapshot` and `/events` for programmatic consumers.
- Structured logging via pino with rotating-file writer.

#### Control plane (`--control-plane`)
- Persistent registry of project runtimes (`~/.cognit-flow/projects.json`).
- HTTP API for registering, starting, stopping, restarting tmux-managed
  runtimes.
- Background prober that pings each runtime's dashboard and tracks
  running / stopped / error state.

#### CLI
- `cognit-flow [--port <n>] [--logs-root <dir>] [--language <name>]
  [--control-plane] <workflow.md>` with mandatory acknowledgement flag.
- ASCII guardrails banner that mirrors the upstream Elixir CLI semantics.

### Tested
- 80 vitest tests, ~2s wall time on CI.
- TypeScript strict mode, `exactOptionalPropertyTypes`, no `any` in source.
- End-to-end smoke runs verified against real Linear API + real `claude` CLI
  and real `codex app-server` (see `gxPan1006/cognit-flow` issue history).

### Limitations (documented; on the roadmap)
- Remote SSH worker hosts (`worker.ssh_hosts`) — parsed but not yet executed.
- Stall detection (auto-restart of agents past `stall_timeout_ms`) — hook in
  place, kill logic pending.
- Trackers beyond Linear (Jira, GitHub Issues, Plane) — adapter boundary is
  ready, no implementations yet.

[Unreleased]: https://github.com/gxPan1006/cognit-flow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gxPan1006/cognit-flow/releases/tag/v0.1.0
