<div align="center">

# KongCode

![KongCode](kongcodeLogoV4.png)

[![VoidOrigin](https://img.shields.io/badge/VOIDORIGIN-voidorigin.com-0a0a0a?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIHN0cm9rZT0iI2ZmNmIzNSIgc3Ryb2tlLXdpZHRoPSIyIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIgZmlsbD0iI2ZmNmIzNSIvPjwvc3ZnPg==&logoColor=ff6b35&labelColor=0a0a0a)](https://voidorigin.com)

[![Version](https://img.shields.io/badge/v0.6.5-release-4cc71e?style=for-the-badge)](https://github.com/42U/kongcode)
[![GitHub Stars](https://img.shields.io/github/stars/42U/kongcode?style=for-the-badge&logo=github&color=gold)](https://github.com/42U/kongcode)
[![License: MIT](https://img.shields.io/github/license/42U/kongcode?style=for-the-badge&logo=opensourceinitiative&color=blue)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0-ff00a0?style=for-the-badge&logo=surrealdb&logoColor=white)](https://surrealdb.com)
[![Tests](https://img.shields.io/badge/Tests-498_passing-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)

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

KongCode 0.6.0 ships with a self-contained first-run bootstrap. No manual SurrealDB install, no manual model download, no shell scripts.

### Prerequisites

Both must be installed and on PATH before installing the plugin. Claude Code's plugin loader spawns kongcode via `node`, so missing Node will fail with "Failed to reconnect to plugin:kongcode."

| Tool | Reason | Check |
|---|---|---|
| **Node.js ≥ 18** + npm | MCP server runtime + `npm ci` during bootstrap | `node -v` and `npm -v` |
| **git** | Claude Code clones the marketplace repo | `git --version` |

Quick installs:

- **macOS**: `brew install node git` (or download from https://nodejs.org and https://git-scm.com)
- **Windows (PowerShell, elevated)**: `winget install OpenJS.NodeJS.LTS Git.Git` then **restart your terminal AND Claude Code** so the new PATH is picked up.
- **Linux**: use your distro's package manager (`apt install nodejs npm git` / `dnf install nodejs npm git` / etc.) or [nvm](https://github.com/nvm-sh/nvm).

### 1. Install the plugin

In Claude Code:

```
/plugin marketplace add 42U/kongcode
/plugin install kongcode@kongcode-marketplace
```

### 2. Open a session

```bash
claude
```

On first run, the kongcode MCP server provisions everything it needs (one-time, ~2-3 minutes depending on your connection):

- Installs npm deps under the plugin (pulls node-llama-cpp's platform-correct native binding)
- Downloads the SurrealDB binary for your platform from the official GitHub release into `~/.kongcode/cache/`
- Downloads the BGE-M3 GGUF embedding model (~420MB) from Hugging Face into `~/.kongcode/cache/models/`
- Spawns a managed SurrealDB child process on `127.0.0.1:18765` backed by `~/.kongcode/data/`

Subsequent sessions skip bootstrap and start in seconds.

### Updating

```
/plugin marketplace update kongcode-marketplace
/plugin update kongcode@kongcode-marketplace
```

There's no auto-update — Claude Code's plugin system requires explicit user-initiated updates.

### Bring-your-own-SurrealDB (advanced)

If you'd rather use a SurrealDB instance you already run, set `SURREAL_URL` and the bootstrap skips the managed child:

```bash
export SURREAL_URL="ws://localhost:8000/rpc"
export SURREAL_USER=root
export SURREAL_PASS=root
```

Other override env vars: `SURREAL_BIN_PATH`, `KONGCODE_CACHE_DIR`, `KONGCODE_DATA_DIR`, `EMBED_MODEL_PATH`, `KONGCODE_SURREAL_PORT`, `KONGCODE_SKIP_BOOTSTRAP=1` (disables bootstrap entirely).

### Platform support

- **Linux x64**: tested end-to-end as of 0.6.0
- **Linux arm64, macOS x64/arm64, Windows x64**: bootstrap supports them but hasn't been smoke-tested at release time. If you hit issues, please file at https://github.com/42U/kongcode/issues.

## Architecture

```
Claude Code Session
├── MCP Server (kongcode) ← long-lived, owns DB + embeddings + state
│   ├── MCP Tools: recall, core_memory, introspect, create_knowledge_gems,
│   │              fetch_pending_work, commit_work_results
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

## Skill Suite

KongCode ships a suite of production-grade skills that encode reusable patterns for managing graph memory across sessions. Each skill lives in `skills/<name>/SKILL.md` with frontmatter triggers and auto-activates on matching user prompts.

**Foundation:**
- `kongcode-health` — pre-flight check before graph writes (runs introspect, recall probe, fetch_pending_work)
- `ground-on-memory` — enforce grounding discipline: scan injected context, cite relevant items, note when nothing matches

**Intelligence:**
- `recall-explain` — cluster recall output, flag contradictions, produce narrative evidence summaries
- `capture-insight` — foreground knowledge capture without waiting for the batch daemon

**Write-time quality:**
- `supersede-stale` — realtime supersession of outdated concepts
- `extract-knowledge` — source-agnostic extraction (PDF, code, URL, doc, transcript) with cross-source linking

**Compound value:**
- `synthesize-sources` — multi-source meta-concept generation with cross-link edges
- `knowledge-gap-scan` — topic coverage analysis before research
- `audit-drift` — periodic sweep for stale knowledge

Canonical edge vocabulary: `src/engine/edge-vocabulary.ts`. Full workflow docs: [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md).

## Upgrade tracking

Non-trivial changes to kongcode use a JSON-driven executor pattern at `.upgrade/`:

- `.upgrade/plan.json` — source of truth for phases, tasks, bugs, metrics, and decisions
- `.upgrade/exec.sh` — idempotent task runner with `status`, `next`, `run`, `phase`, `mark`, `metric`, and `util` subcommands
- `.upgrade/actions/phase*.sh` — per-phase action implementations
- `.upgrade/tools/check-utilization.mjs` — windowed `retrieval_outcome` analysis (invoked via `./exec.sh util`)

The `./exec.sh util` command reports per-window retrieval utilization (lifetime / last 7d / last 24h / last 1h) directly from SurrealDB — use this to track grounding-metric movement over time instead of the lifetime average, which is dragged down by historical data.

## Development

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run typecheck  # Type check only
npm test           # Run tests
```

---

<div align="center">

MIT License | Built by [42U](https://github.com/42U) | [VoidOrigin](https://voidorigin.com)

</div>
