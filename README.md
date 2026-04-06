# KongCode

Graph-backed permanent memory for Claude Code. Forked from [KongBrain](https://github.com/42U/kongbrain).

## What It Does

KongCode gives Claude Code persistent memory that learns across sessions:

| Feature | Without KongCode | With KongCode |
|---------|-----------------|---------------|
| Memory | File-based, per-project | SurrealDB graph, cross-project |
| Context | Sliding window, lost on session end | Retrieval-augmented, persists forever |
| Learning | None | 9 knowledge types extracted per session |
| Skills | None | Procedural memory from successful workflows |
| Identity | Stateless | Earned soul via graduation system |

## Quick Start

### 1. Start SurrealDB

```bash
# Docker (recommended)
docker run -d --name surrealdb -p 8042:8000 \
  surrealdb/surrealdb:latest start --user root --pass root

# Or native
curl -sSf https://install.surrealdb.com | sh
surreal start --user root --pass root --bind 0.0.0.0:8042
```

### 2. Install KongCode

```bash
git clone https://github.com/42U/kongcode.git ~/.claude/plugins/kongcode
cd ~/.claude/plugins/kongcode
npm install && npm run build
```

### 3. Set API Key (for background learning)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Use Claude Code

KongCode activates automatically. Memory is extracted and retrieved transparently.

## Architecture

```
Claude Code Session
├── MCP Server (kongcode) ← long-lived, owns DB + embeddings + state
│   ├── MCP Tools: recall, core_memory, introspect
│   └── Unix Socket API ← hook communication
└── Hook Scripts ← thin proxies to MCP server
    ├── SessionStart     → bootstrap + wakeup briefing
    ├── UserPromptSubmit → context retrieval + injection
    ├── PreToolUse       → tool budget gating
    ├── PostToolUse      → outcome tracking
    ├── Stop             → turn ingestion
    ├── PreCompact       → context preservation
    └── SessionEnd       → extraction + graduation
```

## Commands

| Command | Description |
|---------|-------------|
| `/recall [query]` | Search past knowledge |
| `/core-memory [action]` | Manage always-loaded directives |
| `/introspect [action]` | Database diagnostics |
| `/kongcode-status` | System health dashboard |

## Configuration

Environment variables (all optional, sensible defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `SURREAL_URL` | `ws://localhost:8042/rpc` | SurrealDB WebSocket URL |
| `SURREAL_USER` | `root` | SurrealDB username |
| `SURREAL_PASS` | `root` | SurrealDB password |
| `SURREAL_NS` | `kong` | SurrealDB namespace |
| `SURREAL_DB` | `memory` | SurrealDB database |
| `ANTHROPIC_API_KEY` | (required for learning) | For daemon extraction LLM calls |
| `KONGCODE_MODEL` | `claude-sonnet-4-20250514` | Model for internal LLM calls |
| `KONGCODE_LOG_LEVEL` | `warn` | Log level: error, warn, info, debug |

## How It Works

### Every Turn
1. **UserPromptSubmit** — classifies intent, retrieves relevant graph context, injects as system message
2. **PreToolUse** — tracks tool calls against adaptive budget
3. **PostToolUse** — records outcomes, tracks artifacts
4. **Stop** — ingests turn, accumulates tokens

### Between Turns
- Memory daemon extracts: concepts, causal chains, monologues, corrections, preferences, artifacts, decisions, skills

### Between Sessions
- Handoff note captures session state for next wakeup
- Deferred cleanup processes orphaned sessions

### Soul Graduation
After 15+ sessions with sufficient quality (reflections, causal chains, concepts), the agent earns a Soul — an emergent identity document with working style, self-observations, and evidence-grounded values.

## Development

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run typecheck  # Type check only
npm test           # Run tests
```

## License

MIT
