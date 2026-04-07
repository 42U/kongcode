#!/usr/bin/env bash
# KongCode hook proxy — forwards Claude Code hook events to the MCP server's
# internal HTTP API via Unix socket or TCP port.
#
# Usage: hook-proxy.sh <event-name>
# Reads hook payload JSON from stdin, returns hook response JSON on stdout.
# Fails open (returns {}) if the MCP server is unreachable.

set -euo pipefail

HOOK_EVENT="${1:?Missing hook event name}"
INPUT=$(cat)

# Discover MCP server endpoint — socket lives in user's home dir
SOCK_FILE="${HOME}/.kongcode.sock"
PORT_FILE="${HOME}/.kongcode-port"

if [ -S "$SOCK_FILE" ]; then
  RESPONSE=$(echo "$INPUT" | curl -sf --unix-socket "$SOCK_FILE" \
    -X POST -H "Content-Type: application/json" \
    --max-time 10 \
    -d @- "http://localhost/hook/${HOOK_EVENT}" 2>/dev/null) || RESPONSE='{}'
elif [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
  RESPONSE=$(echo "$INPUT" | curl -sf \
    -X POST -H "Content-Type: application/json" \
    --max-time 10 \
    -d @- "http://127.0.0.1:${PORT}/hook/${HOOK_EVENT}" 2>/dev/null) || RESPONSE='{}'
else
  # MCP server not ready yet — pass through
  RESPONSE='{}'
fi

echo "$RESPONSE"
exit 0
