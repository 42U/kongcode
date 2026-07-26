/**
 * LaqrumCode MCP client — thin per-Claude-Code-session process.
 *
 * Replaces the legacy src/mcp-server.ts as the binary that .mcp.json invokes.
 * Owns only:
 *   - stdio transport with Claude Code (MCP server end)
 *   - JSON-RPC client to laqrumcode-daemon (heavy state lives there)
 *
 * On startup:
 *   1. ensureDaemon() — connects to existing daemon or spawns one
 *   2. Sets up MCP Server with stdio transport
 *   3. Registers ListTools / CallTool handlers that forward over IPC
 *   4. Connects stdio so Claude Code's handshake succeeds quickly
 *
 * Bootstrap responsibility moves to the daemon. The client is small (~200
 * lines) so plugin updates are fast and the SEA-bundle for it is tiny
 * (no embedding model, no SurrealDB, no native bindings to pull in).
 */
/** Track our session ID so every IPC call carries it — daemon's session map
 *  is keyed on this.
 *
 *  ipc-types.ts states the contract: "Every RPC carries the originating Claude
 *  Code session id". Until v0.8.5 this invented `mcp-client-${pid}` instead,
 *  which meant the daemon held TWO SessionStates per conversation in two
 *  disjoint id spaces — the hook path keyed on Claude Code's UUID, the tool
 *  path on our pid — and anything written under one identity was invisible to
 *  the other. That silently broke tier-1 core-memory scoping (rows written by
 *  the core_memory tool could never match the session rendering context) and
 *  `injectedSections` invalidation (it cleared the cache on the session that
 *  does not build the prompt). It also reset the per-session tier-0 write cap
 *  whenever the relay restarted mid-conversation.
 *
 *  Claude Code exports the real id as CLAUDE_CODE_SESSION_ID (verified present
 *  on live relay processes, distinct per conversation, stable across the
 *  conversation). Prefer it.
 *
 *  Precedence is deliberate:
 *   - LAQRUMCODE_SESSION_ID first: an explicit pin must always win.
 *     daemon/auto-drain.ts sets it to a fresh UUID specifically to isolate a
 *     spawned drain agent from its parent; inheriting CLAUDE_CODE_SESSION_ID
 *     would undo that.
 *   - CLAUDE_CODE_SESSION_ID second: the contract's intended value.
 *   - pid last: unchanged behaviour for non-Claude-Code MCP hosts, where
 *     neither variable exists.
 *
 *  Note CLAUDE_CODE_CHILD_SESSION is a boolean flag ("1"), not a rival id — a
 *  subagent still reports its parent conversation, which is the attribution we
 *  want. */
export declare function resolveSessionId(env?: NodeJS.ProcessEnv, pid?: number): string;
/** Decide what to do given a version-mismatch outcome from meta.requestSupersede.
 *  Pure function so the policy is testable without real socket setup. */
export declare function decideOrphanAction(activeClients: number | undefined): "recycle" | "wait" | "abstain";
/**
 * Test-only exports. Not part of the public API.
 * @internal
 */
export declare const __testing: {
    compareSemver: (a: string, b: string) => number;
};
