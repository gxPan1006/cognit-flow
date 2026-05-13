# Cognit Flow

TypeScript port of the [Elixir Cognition](../elixir) coding-agent orchestrator.

Behavior-equivalent with the Elixir implementation. Internal structure organized for TS
conventions (Effect-free, class-based state machines, async event loop instead of OTP processes).

## Status

Work in progress — see `../MEMORY.md` for porting status and outstanding modules.

## Run

```bash
cd ts
npm install
npm run dev -- ./WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

After `npm run build`, the compiled binary is at `bin/cognition.js`.

Flags:

- `--logs-root <path>` — log directory (default `./log`).
- `--port <port>` — start the observability dashboard.
- `--language <name>` — language for Linear-facing output (e.g. `中文`).
- `--control-plane` — run as a control-plane registry instead of a project orchestrator.

## Project Layout

- `src/` — application code (mirrors `elixir/lib/` semantics, idiomatic TS structure).
- `test/` — vitest equivalents of the Elixir test suite.
- `bin/cognition.js` — built CLI (after `npm run build`).

## License

Apache-2.0 (same as the parent project).
