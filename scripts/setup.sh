#!/usr/bin/env bash
# KongCode setup — checks prerequisites and guides initial configuration.
set -euo pipefail

echo "=== KongCode Setup ==="
echo ""

# Check SurrealDB
SURREAL_URL="${SURREAL_URL:-ws://localhost:8042/rpc}"
HTTP_URL=$(echo "$SURREAL_URL" | sed 's|ws://|http://|' | sed 's|wss://|https://|' | sed 's|/rpc|/health|')

echo "Checking SurrealDB at ${SURREAL_URL}..."
if curl -sf --max-time 3 "$HTTP_URL" >/dev/null 2>&1; then
  echo "  [OK] SurrealDB is running"
else
  echo "  [MISSING] SurrealDB not reachable at ${SURREAL_URL}"
  echo ""
  echo "  Install SurrealDB:"
  echo "    Docker:  docker run -d --name surrealdb -p 8042:8000 surrealdb/surrealdb:latest start --user root --pass root"
  echo "    Native:  curl -sSf https://install.surrealdb.com | sh && surreal start --user root --pass root --bind 0.0.0.0:8042"
  echo ""
fi

# Check ANTHROPIC_API_KEY
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  [OK] ANTHROPIC_API_KEY is set"
else
  echo "  [OPTIONAL] ANTHROPIC_API_KEY not set — daemon extraction will be disabled"
  echo "    Set it for automatic knowledge extraction: export ANTHROPIC_API_KEY=sk-ant-..."
fi

# Check embedding model
MODEL_PATH="${EMBED_MODEL_PATH:-$HOME/.node-llama-cpp/models/bge-m3-q4_k_m.gguf}"
if [ -f "$MODEL_PATH" ]; then
  echo "  [OK] Embedding model found at ${MODEL_PATH}"
else
  echo "  [INFO] Embedding model will auto-download on first use (~420MB)"
fi

echo ""
echo "Setup complete. Start Claude Code with this plugin to begin."
