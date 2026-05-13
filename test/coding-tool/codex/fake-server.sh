#!/usr/bin/env bash
# Fake Codex app-server: reads JSON-RPC messages on stdin, replies with
# scripted responses. Used by codex adapter tests to verify the handshake +
# turn flow without depending on the real codex binary.
set -euo pipefail

reply_initialize=0
reply_thread=0
reply_turn=0

while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -nE 's/.*"id":[[:space:]]*([0-9]+).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{"capabilities":{}}}\n' "$id"
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '{"id":%s,"result":{"thread":{"id":"thread-fake"}}}\n' "$id"
      ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-fake"}}}\n' "$id"
      # After turn/start succeeds, emit one notification and then completion.
      printf '{"method":"item/agentMessage","params":{"text":"hi"}}\n'
      printf '{"method":"turn/completed","params":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n'
      ;;
    *)
      # Echo unknown protocol messages to stderr for debugging.
      printf 'fake-server: unknown line: %s\n' "$line" >&2
      ;;
  esac
done
