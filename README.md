<div align="center">

# KongCode

![KongCode](kongcodeLogoV4.png)

[![VoidOrigin](https://img.shields.io/badge/VOIDORIGIN-voidorigin.com-0a0a0a?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIHN0cm9rZT0iI2ZmNmIzNSIgc3Ryb2tlLXdpZHRoPSIyIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIgZmlsbD0iI2ZmNmIzNSIvPjwvc3ZnPg==&logoColor=ff6b35&labelColor=0a0a0a)](https://voidorigin.com)

[![Version](https://img.shields.io/badge/v0.7.15-stable-22c55e?style=for-the-badge)](https://github.com/42U/kongcode)
[![GitHub Stars](https://img.shields.io/github/stars/42U/kongcode?style=for-the-badge&logo=github&color=gold)](https://github.com/42U/kongcode)
[![License: MIT](https://img.shields.io/github/license/42U/kongcode?style=for-the-badge&logo=opensourceinitiative&color=blue)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0-ff00a0?style=for-the-badge&logo=surrealdb&logoColor=white)](https://surrealdb.com)
[![Tests](https://img.shields.io/badge/Tests-498_passing-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)

**Graph-backed permanent memory for [Claude Code](https://claude.ai/claude-code).** Forked from [KongBrain](https://github.com/42U/kongbrain).

[Quick Start](#quick-start) | [Architecture](#architecture) | [Configuration](#configuration) | [Troubleshooting](#troubleshooting) | [Development](#development)

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

KongCode ships with a self-contained first-run bootstrap. No manual SurrealDB install, no model download, no shell scripts. Just two slash commands.

### Prerequisites

| Tool | When required |
|---|---|
| **git** | Always — Claude Code uses it to clone the marketplace repo |
| **Node.js ≥ 18 + npm** | Only when running the JS fallback (no SEA binary for your platform yet, or running from a dev checkout). Most users on linux-x64/arm64, macOS x64/arm64, win-x64 get the SEA binary and don't need Node. |

Quick installs (only if you need Node + git for the fallback path):

- **macOS**: `brew install node git`
- **Windows (PowerShell, elevated)**: `winget install OpenJS.NodeJS.LTS Git.Git` then **restart your terminal AND Claude Code** so the new PATH is picked up.
- **Linux**: distro package manager (`apt install nodejs npm git`) or [nvm](https://github.com/nvm-sh/nvm).

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

On first run, the kongcode daemon provisions everything it needs (one-time, ~2-3 minutes depending on your connection):

- Installs npm deps (pulls node-llama-cpp's platform-correct native binding)
- Downloads the SurrealDB binary for your platform from the official GitHub release into `~/.kongcode/cache/`
- Downloads the BGE-M3 GGUF embedding model (~420MB) from Hugging Face into `~/.kongcode/cache/models/`
- Spawns a managed SurrealDB child process backed by `~/.kongcode/data/`

Subsequent sessions skip bootstrap and start in seconds — they warm-attach to the long-lived daemon.

### Updating

```
/plugin marketplace update kongcode-marketplace
/plugin update kongcode@kongcode-marketplace
```

There's no auto-update — Claude Code's plugin system requires explicit user-initiated updates. Once you update, the new mcp-client detects it's running newer than the daemon, flags the daemon for graceful exit on next disconnect, and the next session you open spawns a fresh daemon with the new code. No manual restart of anything.

### Bring-your-own-SurrealDB (advanced)

If you'd rather use a SurrealDB instance you already run, set `SURREAL_URL` and the bootstrap skips the managed child:

```bash
export SURREAL_URL="ws://localhost:8000/rpc"
export SURREAL_USER=root
export SURREAL_PASS=root
```

KongCode also auto-detects existing kongcode SurrealDB instances on common ports (8000, 8042) at startup, so you usually don't need to set this manually if you already have one running.

### Platform support

| Platform | SEA binary | JS fallback (needs Node) |
|---|---|---|
| linux-x64 | ✅ | ✅ |
| linux-arm64 | ✅ | ✅ |
| macOS-arm64 | ✅ | ✅ |
| macOS-x64 | — | ✅ if Node 18+ available |
| win32-x64 | ✅ | ✅ |
| Other | — | ✅ if Node 18+ available |

If you hit issues, please file at https://github.com/42U/kongcode/issues.

## Architecture

KongCode runs as **two cooperating processes**:

```
                    ┌────────────────────────────────────────────┐
                    │  kongcode-daemon (long-lived, 1 per host)  │
                    │  ┌──────────────────────────────────────┐  │
                    │  │ SurrealStore (graph DB connection)   │  │
                    │  │ EmbeddingService (BGE-M3 in RAM)     │  │
                    │  │ ACAN weights + retrain loop          │  │
                    │  │ All 12 tool + 10 hook handlers       │  │
                    │  │ Auto-drain scheduler                 │  │
                    │  └──────────────────────────────────────┘  │
                    │                       ▲                    │
                    │           Unix socket │ JSON-RPC 2.0       │
                    │     ~/.kongcode-daemon.sock                │
                    └────────────────────┬─┴──────────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
   ┌──────────┴──────────┐    ┌──────────┴──────────┐    ┌──────────┴──────────┐
   │  kongcode-mcp #1    │    │  kongcode-mcp #2    │    │  headless drainer   │
   │  (Claude Code A)    │    │  (Claude Code B)    │    │  (auto-drain spawn) │
   └─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

- **kongcode-daemon**: long-lived background process owning the SurrealDB connection, BGE-M3 embedding model (~150MB RAM), ACAN weights, all tool/hook handlers, and the auto-drain scheduler. Survives plugin updates, MCP restarts, and Claude Code crashes. Auto-recycles cleanly on version mismatch via the supersede protocol.
- **kongcode-mcp**: thin per-Claude-Code-session client (~50MB RAM). Forwards MCP RPC to the daemon over local IPC. Plugin updates only restart this; the daemon keeps running.

**Multiple Claude Code sessions share one daemon** — one BGE-M3 in RAM instead of N copies, one SurrealDB connection pool. The daemon tracks per-client identity (`{pid, version, sessionId}` registered at handshake) and serves all attached clients concurrently.

### Lifecycle highlights

- **Spawn**: first mcp-client without a live daemon socket forks one (detached + unref'd, PID-file-locked spawn).
- **Idle reap**: when no clients are attached for `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` (default 6s), daemon gracefully exits to free RAM. Next client spawns a fresh one.
- **Supersede on update**: a newer mcp-client calls `meta.requestSupersede` — daemon flags itself for exit when its last attached client disconnects. Older sibling sessions keep working until they naturally close. The next spawn uses the new code.
- **Auto-drain**: when the `pending_work` queue exceeds `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5), daemon shells out to `claude --agent kongcode:memory-extractor -p ...` headless. The extractor processes the queue and exits. See [Auto-drain & costs](#auto-drain--costs) below.

## Auto-drain & costs

KongCode's memory extraction (causal chains, concepts, skills, etc.) is cognitive work that needs an LLM. To avoid managing API keys or duplicating the cognitive layer, the daemon **shells out to your already-authenticated `claude` CLI** to drain the queue. Specifically:

```bash
claude --agent kongcode:memory-extractor --print --permission-mode bypassPermissions "..."
```

This invocation runs as a regular Claude Code subagent under your existing authentication, **consuming tokens against your normal Claude Code quota**. Each spawn drains roughly 5-15 queued items before exiting.

**Cadence**:
- Startup check immediately after the daemon initializes
- Every 5 minutes (`KONGCODE_AUTO_DRAIN_INTERVAL_MS`) while the daemon is alive
- Once after each `SessionEnd` hook, debounced via PID-file lock

**Cost gating**:
- `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5): below this queue size, scheduler is a no-op
- PID-file lock at `~/.kongcode/cache/auto-drain.pid` prevents overlapping spawns
- `KONGCODE_AUTO_DRAIN=0` disables the entire scheduler — falls back to manual subagent spawning at session start (the assistant sees an alert and chooses whether to spawn)

If you'd rather kongcode never auto-spawn anything: `export KONGCODE_AUTO_DRAIN=0` in your shell rc.

## Commands

| Command | Description |
|---------|-------------|
| `/recall [query]` | Search past knowledge |
| `/core-memory [action]` | Manage always-loaded directives |
| `/introspect [action]` | Database diagnostics |
| `/kongcode-status` | System health dashboard |

## Configuration

All env vars are optional with sensible defaults.

### SurrealDB connection

| Variable | Default | Description |
|----------|---------|-------------|
| `SURREAL_URL` | `ws://localhost:8042/rpc` | SurrealDB WebSocket URL. Auto-detect probes 8000/8042 first. |
| `SURREAL_USER` | `root` | SurrealDB username |
| `SURREAL_PASS` | `root` | SurrealDB password |
| `SURREAL_NS` | `kong` | SurrealDB namespace |
| `SURREAL_DB` | `memory` | SurrealDB database |
| `SURREAL_BIN_PATH` | (auto) | Path to surreal binary; bypasses bootstrap download |

### Cache & data paths

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_CACHE_DIR` | `~/.kongcode/cache` | Where binaries, models, and lock files live |
| `KONGCODE_DATA_DIR` | `~/.kongcode/data` | SurrealDB data directory |
| `EMBED_MODEL_PATH` | (auto) | Override path to the BGE-M3 GGUF file |
| `KONGCODE_SURREAL_PORT` | `18765` | Managed SurrealDB child's port (when bootstrap spawns one) |

### Bootstrap & daemon lifecycle

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_SKIP_BOOTSTRAP` | `0` | Set `1` to skip first-run provisioning entirely |
| `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` | `6000` | Daemon exits this long after the last client disconnects. Set `0` to disable idle reap. |
| `KONGCODE_DAEMON_TRANSPORT` | `unix` | Set `tcp` to force loopback TCP (Windows/paranoid setups) |
| `KONGCODE_NODE_LLAMA_CPP_PATH` | (auto) | Override path to node-llama-cpp install |
| `KONGCODE_LEGACY_MONOLITH` | `0` | Set `1` to fall back to pre-0.7.0 single-process mode (emergency rollback) |

### Auto-drain

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_AUTO_DRAIN` | `1` | Set `0` to disable the auto-drain scheduler entirely |
| `KONGCODE_AUTO_DRAIN_THRESHOLD` | `5` | Min `pending_work` queue size before scheduler spawns an extractor |
| `KONGCODE_AUTO_DRAIN_INTERVAL_MS` | `300000` | Periodic check cadence (5 min) |
| `KONGCODE_CLAUDE_BIN` | (auto) | Explicit path to the `claude` binary; otherwise scheduler uses `which claude` |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_LOG_LEVEL` | `warn` | One of `error`, `warn`, `info`, `debug` |

## How It Works

### Every Turn
1. **UserPromptSubmit** — classifies intent, retrieves relevant graph context, injects via `additionalContext`. Increments `session.turn_count` and ensures a session DB row exists.
2. **PreToolUse** — tracks tool calls against adaptive budget
3. **PostToolUse** — records outcomes, tracks artifacts
4. **Stop** — ingests the assistant's response, accumulates token deltas

### Between Turns
- Background subagent extracts: concepts, causal chains, monologues, corrections, preferences, artifacts, decisions, skills (auto-drain scheduler triggers when the queue exceeds the threshold)

### Between Sessions
- SessionEnd queues 5-6 cognitive work items (extraction, handoff, reflection, skill, causal graduation, soul evolve)
- Auto-drain spawns a headless extractor to process them before the next session starts
- Deferred cleanup processes orphaned sessions (sessions that ended without a clean shutdown)

### Soul Graduation
After 15+ sessions with sufficient quality (reflections, causal chains, concepts), the agent earns a Soul — an emergent identity document with working style, self-observations, and evidence-grounded values.

## Troubleshooting

### "Failed to reconnect to plugin:kongcode"

The mcp-client failed to start. Common causes:

- **Node not on PATH** (Windows post-winget install): restart your terminal AND Claude Code so the new PATH takes effect
- **Daemon binary corrupted**: `rm -rf ~/.kongcode/cache && claude` will re-bootstrap
- **Port conflict**: another process is on 18765 (the managed SurrealDB port). Set `KONGCODE_SURREAL_PORT` to a free port.

Check the daemon log for the actual error: `tail -100 ~/.kongcode/cache/daemon.log`

### Daemon won't recycle to new version

If you've updated kongcode but the running daemon stays on the old code:

- Other Claude Code sessions or background extractors may still be attached. Daemon waits for ALL clients to disconnect before honoring the supersede flag (architectural invariant: never disrupt a sibling session for an upgrade).
- Force-recycle: `kill -TERM $(cat ~/.kongcode/cache/daemon.pid)`. The next client will spawn a fresh daemon. Cost: ~3-5s of cold-start on the next session.

### Auto-drain isn't running

Check:

```bash
# Is auto-drain disabled?
echo $KONGCODE_AUTO_DRAIN  # should be empty or "1"
# Is the scheduler holding a lock?
cat ~/.kongcode/cache/auto-drain.pid 2>/dev/null
# Is claude binary findable?
which claude
```

If the binary isn't on PATH, set `KONGCODE_CLAUDE_BIN=/path/to/claude` and restart Claude Code.

### Pending_work queue keeps growing

Each session end queues 5-6 items. If queue is growing faster than draining:

- Check daemon log: `grep auto-drain ~/.kongcode/cache/daemon.log`
- Threshold gate may be skipping spawns: lower `KONGCODE_AUTO_DRAIN_THRESHOLD=1` to trigger more aggressively
- Manually trigger a drain via the `kongcode-health` skill or by spawning a `kongcode:memory-extractor` subagent

### Files & paths to know

| Path | Purpose |
|------|---------|
| `~/.kongcode/cache/daemon.pid` | PID of the running daemon |
| `~/.kongcode/cache/daemon.log` | Daemon stdout/stderr (lifecycle, errors) |
| `~/.kongcode/cache/daemon.spawn.lock` | Held during daemon spawn; cleaned on exit |
| `~/.kongcode/cache/auto-drain.pid` | Held while a headless extractor is running |
| `~/.kongcode/cache/surreal.pid` | Managed SurrealDB child's PID (if bootstrapped) |
| `~/.kongcode-daemon.sock` | Daemon's IPC listening socket |
| `~/.kongcode-<pid>.sock` | Daemon's per-PID HTTP socket for hook-proxy.cjs |
| `~/.kongcode/data/` | SurrealDB data files |
| `~/.kongcode/cache/models/` | Downloaded GGUF embedding model |

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

## Development

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run typecheck  # Type check only
npm test           # Run tests (498 passing)
```

The `dist/` directory ships in releases (un-gitignored); contributors developing against the dev tree should `npm run build` to regenerate before testing.

---

<div align="center">

MIT License | Built by [42U](https://github.com/42U) | [VoidOrigin](https://voidorigin.com)

</div>
