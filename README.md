<div align="center">

# KongCode

![KongCode](kongcodeLogoV4.png)

[![VoidOrigin](https://img.shields.io/badge/VOIDORIGIN-voidorigin.com-0a0a0a?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIHN0cm9rZT0iI2ZmNmIzNSIgc3Ryb2tlLXdpZHRoPSIyIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIgZmlsbD0iI2ZmNmIzNSIvPjwvc3ZnPg==&logoColor=ff6b35&labelColor=0a0a0a)](https://voidorigin.com)

[![Version](https://img.shields.io/badge/v0.1.1-release-4cc71e?style=for-the-badge)](https://github.com/42U/kongcode)
[![GitHub Stars](https://img.shields.io/github/stars/42U/kongcode?style=for-the-badge&logo=github&color=gold)](https://github.com/42U/kongcode)
[![License: MIT](https://img.shields.io/github/license/42U/kongcode?style=for-the-badge&logo=opensourceinitiative&color=blue)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0-ff00a0?style=for-the-badge&logo=surrealdb&logoColor=white)](https://surrealdb.com)
[![Tests](https://img.shields.io/badge/Tests-419_passing-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)

**Graph-backed permanent memory for [Claude Code](https://claude.ai/claude-code).** Forked from [KongBrain](https://github.com/42U/kongbrain).

[Quick Start](#quick-start) | [Architecture](#architecture) | [How It Works](#how-it-works) | [Commands](#commands) | [Development](#development)

</div>

---

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

Docker (recommended):

```bash
docker run -d --name surrealdb -p 127.0.0.1:8042:8000 \
  surrealdb/surrealdb:latest start --user root --pass root
```

Or native:

```bash
curl -sSf https://install.surrealdb.com | sh
surreal start --user root --pass root --bind 127.0.0.1:8042
```

> **Security note:** Always bind to `127.0.0.1`, not `0.0.0.0`, unless you need remote access.

### 2. Clone and build

```bash
git clone https://github.com/42U/kongcode.git
cd kongcode
npm install && npm run build
```

### 3. Enable the plugin

Add the following to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "kongcode-marketplace": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/kongcode"
      }
    }
  },
  "enabledPlugins": {
    "kongcode@kongcode-marketplace": true
  }
}
```

Replace `/absolute/path/to/kongcode` with wherever you cloned the repo.

### 4. Start Claude Code

```bash
claude
```

On first startup, KongCode downloads the BGE-M3 embedding model (~420MB) from [Hugging Face](https://huggingface.co/BAAI/bge-m3) and creates all database tables automatically. No manual setup required.

After that, memory is extracted and retrieved transparently every session. No API key needed — all cognitive work is delegated to Claude subagents.

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
| `KONGCODE_LOG_LEVEL` | `warn` | Log level: error, warn, info, debug |

## How It Works

### Every Turn
1. **UserPromptSubmit** — classifies intent, retrieves relevant graph context, injects via `additionalContext`
2. **PreToolUse** — tracks tool calls against adaptive budget
3. **PostToolUse** — records outcomes, tracks artifacts
4. **Stop** — ingests turn, accumulates tokens

### Between Turns
- Claude subagents extract: concepts, causal chains, monologues, corrections, preferences, artifacts, decisions, skills

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

---

<div align="center">

MIT License | Built by [42U](https://github.com/42U)

</div>
