#!/usr/bin/env bash
# sessionStart: export Cursor composer session id for commit-queue attribution.
# Merge this hook into ~/.cursor/hooks.json or .cursor/hooks.json (see integrations/cursor/README.md).
set -euo pipefail

input=$(cat)
session_id=$(
	printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id") or d.get("conversation_id") or "")'
)

if [[ -z $session_id ]]; then
	exit 0
fi

printf '{"env":{"CURSOR_AGENT_SESSION_ID":"%s"}}' "$session_id"
