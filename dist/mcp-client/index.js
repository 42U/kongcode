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
// Wire runtime-downloaded ajv/ajv-formats into NODE_PATH BEFORE importing the
// MCP SDK, so the SDK's dynamic require("ajv/dist/runtime/...") calls resolve
// when running under SEA (where there's no adjacent node_modules). No-op
// in dev tree / npm-ci'd installs since the cache dir doesn't exist there.
import { setupRuntimeNodePath } from "../shared/node-path.js";
setupRuntimeNodePath();
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { IpcClient } from "./ipc-client.js";
import { ensureDaemon } from "./daemon-spawn.js";
import { MCP_TOOLS, MCP_TO_IPC_METHOD } from "../shared/tool-defs.js";
import { log } from "../engine/log.js";
const CLIENT_VERSION = "0.7.7";
let ipc = null;
/** In-flight connect promise — concurrent callers share it so we never
 *  fire two daemon-spawn attempts in parallel (the lock-contention bug
 *  c3fb591 documented). The cache clears on success or failure. */
let ipcInFlight = null;
/** Track our session ID so every IPC call carries it — daemon's session map
 *  is keyed on this. KONGCODE_SESSION_ID env var lets users pin a stable id;
 *  default uses pid for per-process uniqueness. */
const SESSION_ID = process.env.KONGCODE_SESSION_ID ?? `mcp-client-${process.pid}`;
function compareSemver(a, b) {
    const pa = a.split(".").map((s) => Number(s) || 0);
    const pb = b.split(".").map((s) => Number(s) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av !== bv)
            return av - bv;
    }
    return 0;
}
async function connectAndHandshake() {
    const { socketPath, spawned } = await ensureDaemon({
        log: { info: log.info, warn: log.warn, error: log.error },
    });
    log.info(`[mcp-client] daemon ${spawned ? "spawned" : "found"} at ${socketPath}`);
    const client = new IpcClient({ socketPath, log: { info: log.info, warn: log.warn, error: log.error } });
    await client.connect();
    const handshake = await client.handshake();
    // Version-mismatch policy (the user's framing: "if a user has multiple
    // sessions open some might be versions behind doesn't mean we should
    // kill/respawn it UNLESS ITS ORPHANED"):
    //
    //   client > daemon → call meta.requestSupersede(clientVersion). Daemon
    //                     flags itself for exit when its LAST attached client
    //                     disconnects. This client KEEPS USING the current
    //                     daemon — older sibling sessions stay intact, the
    //                     code refresh happens at the natural disconnect
    //                     boundary on next spawn.
    //   client < daemon → forward-compat: just continue. Older clients work
    //                     against newer daemons; IPC is additive.
    //   equal           → unreachable in this branch; nothing to do.
    if (handshake.daemonVersion && handshake.daemonVersion !== CLIENT_VERSION) {
        const cmp = compareSemver(CLIENT_VERSION, handshake.daemonVersion);
        if (cmp > 0) {
            log.warn(`[mcp-client] client v${CLIENT_VERSION} > daemon v${handshake.daemonVersion} — flagging daemon to supersede after last attached client disconnects`);
            try {
                const resp = await client.call("meta.requestSupersede", { clientVersion: CLIENT_VERSION });
                if (resp?.accepted) {
                    log.info(`[mcp-client] supersede flag accepted (${resp.attachedClients} attached); daemon will exit when all disconnect`);
                }
                else {
                    log.warn(`[mcp-client] supersede flag declined by daemon`);
                }
            }
            catch (e) {
                // Older daemons (pre-0.7.7) don't know meta.requestSupersede and
                // return Method-not-found. That's fine — code refresh just won't
                // be auto-promoted; user can manually recycle if they want it.
                log.warn(`[mcp-client] meta.requestSupersede unavailable on this daemon (${e.message}); manual daemon restart required to load v${CLIENT_VERSION} code`);
            }
        }
        else {
            log.warn(`[mcp-client] client v${CLIENT_VERSION} < daemon v${handshake.daemonVersion} — using newer daemon (forward-compat)`);
        }
    }
    return client;
}
async function getOrConnectIpc() {
    if (ipc)
        return ipc;
    if (ipcInFlight)
        return ipcInFlight;
    ipcInFlight = (async () => {
        log.info(`[mcp-client] ensuring daemon is running...`);
        const client = await connectAndHandshake();
        ipc = client;
        return client;
    })().finally(() => { ipcInFlight = null; });
    return ipcInFlight;
}
async function handleToolCall(toolName, args) {
    const ipcMethod = MCP_TO_IPC_METHOD[toolName];
    if (!ipcMethod) {
        return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
    }
    try {
        const client = await getOrConnectIpc();
        const result = await client.call(ipcMethod, { sessionId: SESSION_ID, args });
        return result;
    }
    catch (e) {
        const err = e;
        if (err.code === -32002 /* IpcErrorCode.DAEMON_RESTARTING */ || err.code === -32001 /* IpcErrorCode.DAEMON_BOOTSTRAPPING */) {
            // One retry after re-establishing the connection. If the daemon was
            // mid-restart, this should land cleanly the second time.
            log.warn(`[mcp-client] daemon transient error, reconnecting and retrying once: ${err.message}`);
            ipc?.close();
            ipc = null;
            try {
                const client = await getOrConnectIpc();
                const result = await client.call(ipcMethod, { sessionId: SESSION_ID, args });
                return result;
            }
            catch (retryErr) {
                return {
                    content: [{
                            type: "text",
                            text: `kongcode daemon unavailable after retry: ${retryErr.message}`,
                        }],
                };
            }
        }
        return { content: [{ type: "text", text: `kongcode error: ${err.message}` }] };
    }
}
async function shutdown() {
    log.info("[mcp-client] shutting down...");
    if (ipc) {
        try {
            ipc.close();
        }
        catch { }
        ipc = null;
    }
}
async function main() {
    const server = new Server({ name: "kongcode", version: CLIENT_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: MCP_TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return handleToolCall(name, (args ?? {}));
    });
    // Same shutdown contract as mcp-server: SIGTERM/SIGINT trigger graceful close.
    // Daemon stays alive — the whole point of the split is daemon outlives client.
    process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
    process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
    // Connect stdio FIRST — Claude Code's handshake window is short. Daemon
    // ensure runs in the background after handshake completes.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info(`[mcp-client] kongcode MCP client running on stdio (v${CLIENT_VERSION}, session=${SESSION_ID})`);
    // Eagerly trigger daemon spawn in the background. Required so hook-proxy.cjs
    // can find the daemon's per-PID socket when SessionStart/UserPromptSubmit/
    // Stop hooks fire — those go through hook-proxy directly (NOT through MCP
    // RPC), so they need the per-PID HTTP socket the daemon opens during its
    // own startup. Without this eager call, hooks silently no-op until the
    // user happens to invoke a tool, which may never happen in a session.
    //
    // The in-flight promise cache in getOrConnectIpc() prevents the lock
    // contention bug 0.6.7 hit (background-eager + foreground-tool-call both
    // racing for the spawn lock). Now they share the same in-flight promise.
    getOrConnectIpc().catch((e) => {
        log.warn(`[mcp-client] background daemon connect failed (will retry on first tool call): ${e.message}`);
    });
}
main().catch((err) => {
    log.error("[mcp-client] fatal:", err);
    process.exit(1);
});
