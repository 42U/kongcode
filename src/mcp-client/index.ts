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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { IpcClient, IpcError } from "./ipc-client.js";
import { ensureDaemon } from "./daemon-spawn.js";
import { MCP_TOOLS, MCP_TO_IPC_METHOD } from "../shared/tool-defs.js";
import { IpcErrorCode } from "../shared/ipc-types.js";
import { log } from "../engine/log.js";

const CLIENT_VERSION = "0.7.6";

let ipc: IpcClient | null = null;
/** In-flight connect promise — concurrent callers share it so we never
 *  fire two daemon-spawn attempts in parallel (the lock-contention bug
 *  c3fb591 documented). The cache clears on success or failure. */
let ipcInFlight: Promise<IpcClient> | null = null;
/** Track our session ID so every IPC call carries it — daemon's session map
 *  is keyed on this. KONGCODE_SESSION_ID env var lets users pin a stable id;
 *  default uses pid for per-process uniqueness. */
const SESSION_ID = process.env.KONGCODE_SESSION_ID ?? `mcp-client-${process.pid}`;

async function connectAndHandshake(): Promise<IpcClient> {
  const { socketPath, spawned } = await ensureDaemon({
    log: { info: log.info, warn: log.warn, error: log.error },
  });
  log.info(`[mcp-client] daemon ${spawned ? "spawned" : "found"} at ${socketPath}`);
  const client = new IpcClient({ socketPath, log: { info: log.info, warn: log.warn, error: log.error } });
  await client.connect();
  const handshake = await client.handshake();

  // Version mismatch → daemon is running stale code (e.g. plugin update
  // restarted mcp-client but daemon kept running on the previous binary).
  // Daemon-arch tradeoff: clients update freely, daemon doesn't, so we have
  // to recycle it explicitly. Send meta.shutdown, wait for the daemon to
  // exit, then re-ensureDaemon to spawn a fresh one with new code.
  if (handshake.daemonVersion && handshake.daemonVersion !== CLIENT_VERSION) {
    log.warn(`[mcp-client] version mismatch: client=${CLIENT_VERSION} daemon=${handshake.daemonVersion} — recycling daemon to load new code`);
    try { await client.call("meta.shutdown", {}); } catch { /* daemon exits before responding sometimes */ }
    try { client.close(); } catch {}
    // Wait for socket cleanup so ensureDaemon's fast-path doesn't latch
    // back onto the dying daemon. Bounded poll, 100ms steps, 10s ceiling.
    const { existsSync } = await import("node:fs");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!existsSync(socketPath)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const fresh = await ensureDaemon({
      log: { info: log.info, warn: log.warn, error: log.error },
    });
    log.info(`[mcp-client] post-recycle daemon ${fresh.spawned ? "spawned" : "found"} at ${fresh.socketPath}`);
    const newClient = new IpcClient({ socketPath: fresh.socketPath, log: { info: log.info, warn: log.warn, error: log.error } });
    await newClient.connect();
    const h2 = await newClient.handshake();
    if (h2.daemonVersion !== CLIENT_VERSION) {
      log.warn(`[mcp-client] post-recycle version still mismatched (daemon=${h2.daemonVersion}). Continuing anyway.`);
    }
    return newClient;
  }
  return client;
}

async function getOrConnectIpc(): Promise<IpcClient> {
  if (ipc) return ipc;
  if (ipcInFlight) return ipcInFlight;
  ipcInFlight = (async () => {
    log.info(`[mcp-client] ensuring daemon is running...`);
    const client = await connectAndHandshake();
    ipc = client;
    return client;
  })().finally(() => { ipcInFlight = null; });
  return ipcInFlight;
}

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const ipcMethod = MCP_TO_IPC_METHOD[toolName];
  if (!ipcMethod) {
    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
  }
  try {
    const client = await getOrConnectIpc();
    const result = await client.call<{ content: Array<{ type: "text"; text: string }> }>(
      ipcMethod,
      { sessionId: SESSION_ID, args },
    );
    return result;
  } catch (e) {
    const err = e as IpcError;
    if (err.code === IpcErrorCode.DAEMON_RESTARTING || err.code === IpcErrorCode.DAEMON_BOOTSTRAPPING) {
      // One retry after re-establishing the connection. If the daemon was
      // mid-restart, this should land cleanly the second time.
      log.warn(`[mcp-client] daemon transient error, reconnecting and retrying once: ${err.message}`);
      ipc?.close();
      ipc = null;
      try {
        const client = await getOrConnectIpc();
        const result = await client.call<{ content: Array<{ type: "text"; text: string }> }>(
          ipcMethod,
          { sessionId: SESSION_ID, args },
        );
        return result;
      } catch (retryErr) {
        return {
          content: [{
            type: "text",
            text: `kongcode daemon unavailable after retry: ${(retryErr as Error).message}`,
          }],
        };
      }
    }
    return { content: [{ type: "text", text: `kongcode error: ${err.message}` }] };
  }
}

async function shutdown(): Promise<void> {
  log.info("[mcp-client] shutting down...");
  if (ipc) {
    try { ipc.close(); } catch {}
    ipc = null;
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "kongcode", version: CLIENT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args ?? {}) as Record<string, unknown>);
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
    log.warn(`[mcp-client] background daemon connect failed (will retry on first tool call): ${(e as Error).message}`);
  });
}

main().catch((err) => {
  log.error("[mcp-client] fatal:", err);
  process.exit(1);
});
