/**
 * KongCode MCP client — thin per-Claude-Code-session process.
 *
 * Replaces the legacy src/mcp-server.ts as the binary that .mcp.json invokes.
 * Owns only:
 *   - stdio transport with Claude Code (MCP server end)
 *   - JSON-RPC client to kongcode-daemon (heavy state lives there)
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
export {};
