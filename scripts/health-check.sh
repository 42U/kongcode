#!/usr/bin/env bash
# KongCode health check — quick connectivity diagnostics.
set -euo pipefail

SURREAL_URL="${SURREAL_URL:-ws://localhost:8000/rpc}"
HTTP_URL=$(echo "$SURREAL_URL" | sed 's|ws://|http://|' | sed 's|wss://|https://|' | sed 's|/rpc|/health|')

STATUS="OK"

# SurrealDB
if curl -sf --max-time 3 "$HTTP_URL" >/dev/null 2>&1; then
  echo "SurrealDB: connected (${SURREAL_URL})"
else
  echo "SurrealDB: UNREACHABLE (${SURREAL_URL})"
  STATUS="DEGRADED"
fi

# MCP Server socket
SOCK="${CLAUDE_PROJECT_DIR:-.}/.kongcode.sock"
if [ -S "$SOCK" ]; then
  if curl -sf --unix-socket "$SOCK" --max-time 2 "http://localhost/health" >/dev/null 2>&1; then
    echo "MCP Server: running (Unix socket)"
  else
    echo "MCP Server: socket exists but not responding"
    STATUS="DEGRADED"
  fi
else
  echo "MCP Server: not running (no socket file)"
  STATUS="DEGRADED"
fi

# Embedding model
MODEL_PATH="${EMBED_MODEL_PATH:-$HOME/.node-llama-cpp/models/bge-m3-q4_k_m.gguf}"
if [ -f "$MODEL_PATH" ]; then
  SIZE=$(du -h "$MODEL_PATH" | cut -f1)
  echo "Embedding model: loaded (${SIZE})"
else
  echo "Embedding model: not downloaded yet"
fi

echo ""
echo "Overall: ${STATUS}"
