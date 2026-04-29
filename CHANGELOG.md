# Changelog

All notable changes to KongCode are documented here. The 0.7.x series introduced the daemon-split architecture; 0.8.0 will be the first marketplace-ready stable.

## [Unreleased]

### Added
- README rewrite covering daemon arch, multi-session, auto-drain costs, env-var matrix, and troubleshooting (`README.md`)
- This CHANGELOG file

## [0.7.15] — 2026-04-29

### Fixed
- `backfillSessionTurnCounts` SurrealQL parse error: was constructing `UPDATE <uuid>` statements with raw `turn.session_id` values (Claude Code session UUIDs). Now looks up by `kc_session_id` field. Eliminates the noisy "Cannot perform subtraction with 'e74702b0' and 'eb6b'" entries from `daemon.log`.

## [0.7.14] — 2026-04-29

### Added
- **Auto-drain scheduler restored.** Daemon now spawns `claude --agent kongcode:memory-extractor -p ...` as a headless subprocess when the `pending_work` queue exceeds threshold. Restores the auto-extraction behavior that lived in the in-process MemoryDaemon before commit `4f7b962` removed the Anthropic SDK.
- New env vars: `KONGCODE_AUTO_DRAIN`, `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5), `KONGCODE_AUTO_DRAIN_INTERVAL_MS` (default 300000), `KONGCODE_CLAUDE_BIN`
- New `src/daemon/auto-drain.ts` with PID-file-locked scheduler
- SessionEnd hook triggers an immediate debounced drain check

## [0.7.13] — 2026-04-29

### Changed
- Default idle reap timeout: 60s → 6s. Anything longer was just holding ~150MB of BGE-M3 in RAM for nobody. Configurable via `KONGCODE_DAEMON_IDLE_TIMEOUT_MS`.

## [0.7.12] — 2026-04-29

### Added
- One-time historical backfill: `backfillSessionTurnCounts` runs in `runBootstrapMaintenance` and reconciles `session.turn_count = 0` rows by counting their linked `turn` rows.

### Changed
- `turn_count` increments now happen on UserPromptSubmit (reliable hook, fires at turn start), not Stop (fragile). Token accounting still happens in Stop.
- Split `store.updateSessionStats` into `bumpSessionTurn` and `addSessionTokens`. The combined version is `@deprecated` and kept as a backward-compat shim.

## [0.7.11] — 2026-04-29

### Added
- `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` env var (default 60s) to tune the idle reaper introduced in 0.7.10.

## [0.7.10] — 2026-04-29

### Added
- **Idle reaper.** Daemon exits after `idleTimeoutMs` of zero attached clients. Restores the implicit "die when nobody's home" behavior from the pre-0.7.0 monolith model.
- `meta.health.stats` now includes `idleSince` and `idleTimeoutMs` for observability.

## [0.7.9] — 2026-04-29

### Added
- **Per-socket client identity registry.** `DaemonServer.clients` is now `Map<Socket, ClientInfo>` instead of `Set<Socket>`. New `meta.handshake` request shape accepts `{clientInfo: {pid, version, sessionId}}`; daemon logs connect/disconnect lines with full identity.
- `meta.health.stats.clients` returns the array of identified clients

## [0.7.8] — 2026-04-29

### Added
- **Orphan-recycle fallback.** When a 0.7.8+ mcp-client connects to a pre-0.7.7 daemon and `meta.requestSupersede` returns `-32601 Method not found`, the client falls back to checking `meta.health.activeClients`. If we're the only attached client (orphan), it sends `meta.shutdown` and re-spawns. Closes the bootstrap gap on the upgrade boundary from older daemons.

## [0.7.7] — 2026-04-29

### Added
- **Supersede protocol.** New `meta.requestSupersede` RPC. A newer mcp-client flags the running daemon for graceful exit when its last attached client disconnects. Older sibling sessions keep working until they naturally close. Multi-session-safe code refresh.

### Changed
- `DaemonServer.checkSupersedeReady` fires `onSupersedeReady` callback exactly once per supersede cycle.

## [0.7.6] — 2026-04-29

**Reverted in 0.7.7.** Initial version-mismatch logic killed the daemon on any mismatch; correctly flagged by user as wrong (would disrupt sibling sessions). Replaced with the supersede protocol.

## [0.7.5] — 2026-04-29

### Fixed
- `session.turn_count` stuck at 0: Stop hook now calls `updateSessionStats` to increment per-turn. Previously only PreCompact fired the increment, which is rare.
- `sessionEnd:endSession: Invalid record ID format:` log noise: guarded `endSession` call on truthy `surrealSessionId`.

## [0.7.4] — 2026-04-29

### Fixed
- **ESM `require()` bug in spawn-lock cleanup.** `package.json` is `"type": "module"` so `require("node:fs").unlinkSync(...)` threw ReferenceError silently swallowed by `try/catch`. Three call sites in `mcp-client/daemon-spawn.ts` and one in `daemon/index.ts` patched to use the imported `unlinkSync`/`mkdirSync` directly. Stale `daemon.spawn.lock` files now actually get cleaned up.
- **Lazy session-row backfill on `claude --resume`.** Claude Code doesn't refire SessionStart on resumed conversations, so resumed sessions had no DB row, leaving turns ingested but unattributable. UserPromptSubmit now calls `store.ensureSessionRow(kcSessionId, agentId)` (idempotent) when `session.surrealSessionId` is unset. Closes the X-close orphan pattern forward.

## [0.7.3] — 2026-04-29

### Fixed
- Stale `daemon.spawn.lock` recovery: `tryAcquireSpawnLock` now reads the holder PID, unlinks the file if dead, and retries the lock acquire. Self-heals stale locks from prior daemon attempts that exited without clean release.

## [0.7.2] — 2026-04-29

### Fixed
- **Eager daemon spawn from mcp-client startup.** Hooks fire BEFORE any tool call, so the lazy "spawn daemon on first tool call" path missed every hook in a session that didn't invoke MCP tools. mcp-client now triggers `getOrConnectIpc()` in the background after the MCP stdio handshake completes. In-flight promise cache prevents lock-contention races between the eager call and any concurrent tool-call.

## [0.7.1] — 2026-04-29

### Added
- Daemon now exposes the legacy HTTP API on a per-PID Unix socket (`~/.kongcode-<pid>.sock`) so `hook-proxy.cjs` can find it. Without this, hooks silently no-op'd in the daemon-arch path.
- `.mcp.json` flipped from `node dist/mcp-server.js` (legacy monolith) to `node dist/mcp-client/index.js` (daemon-arch thin client).

## [0.7.0] — 2026-04-28

### Added
- **Daemon-split architecture.** Two cooperating processes:
  - `kongcode-daemon`: long-lived background process owning `SurrealStore`, `EmbeddingService`, ACAN weights, all 12 tool + 10 hook handlers
  - `kongcode-mcp`: thin per-Claude-Code-session client; forwards MCP RPC to daemon via JSON-RPC 2.0 over Unix socket (TCP loopback fallback for Windows)
- Multiple Claude Code sessions share one daemon; one BGE-M3 in RAM regardless of session count
- Daemon survives plugin updates, MCP restarts, and Claude Code crashes via `detached: true, unref()`
- SEA binaries built for linux-x64/arm64, macOS-arm64, win32-x64 (macOS-x64 still falls back to JS)

## [0.6.x series] — 2026-04-28

Self-contained first-run bootstrap shipped:

- `src/engine/bootstrap.ts` provisions SurrealDB binary, BGE-M3 GGUF model, node-llama-cpp native bindings on first run
- `bin-manifest.json` pins versions and per-platform sha256 hashes
- Auto-detects existing kongcode SurrealDB on legacy ports (8000, 8042) before spawning a managed child
- Various Windows-specific fixes (npm.cmd shell:true, PATH propagation guidance)

## [0.5.x series and earlier]

See `git log` for pre-0.6.0 history. Highlights:

- **0.5.4**: restored `userTurnCount` increment in `ingestTurn` (silent-failure regression from `4f7b962`)
- **0.5.1**: closed issue #5 (pending_work drain visibility)
- **0.4.0**: auto-seal contract — `commitKnowledge` auto-fires `narrower`/`broader`/`related_to`/`about_concept`/`mentions` edges on every write
- **0.3.0**: full Option A multi-MCP hardening (atomic weights save, training lockfile, mtime hot-reload)
- **0.2.0**: skill suite + grounding metric instrumentation
- **0.1.x**: initial port from KongBrain
