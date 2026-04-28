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

const CLIENT_VERSION = "0.6.7";

let ipc: IpcClient | null = null;
/** Track our session ID so every IPC call carries it — daemon's session map
 *  is keyed on this. KONGCODE_SESSION_ID env var lets users pin a stable id;
 *  default uses pid for per-process uniqueness. */
const SESSION_ID = process.env.KONGCODE_SESSION_ID ?? `mcp-client-${process.pid}`;

async function getOrConnectIpc(): Promise<IpcClient> {
  if (ipc) return ipc;
  log.info(`[mcp-client] ensuring daemon is running...`);
  const { socketPath, spawned } = await ensureDaemon({
    log: { info: log.info, warn: log.warn, error: log.error },
  });
  log.info(`[mcp-client] daemon ${spawned ? "spawned" : "found"} at ${socketPath}`);
  ipc = new IpcClient({ socketPath, log: { info: log.info, warn: log.warn, error: log.error } });
  await ipc.connect();
  await ipc.handshake();
  return ipc;
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
  // ensure runs lazily on first tool call; if user's first prompt comes
  // during cold daemon spawn, they see "still initializing" via the
  // bootstrap-aware error path inherited from the daemon.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`[mcp-client] kongcode MCP client running on stdio (v${CLIENT_VERSION}, session=${SESSION_ID})`);

  // No eager background daemon connect. Earlier (0.6.7) we did it for "first
  // tool call is fast" but it caused lock contention with the foreground
  // tool-call path's getOrConnectIpc(): both raced for the spawn lock, the
  // foreground gave up with "lock contention — give up". Connect lazily on
  // first tool call instead — mcp-client's init handshake is unaffected.
}

main().catch((err) => {
  log.error("[mcp-client] fatal:", err);
  process.exit(1);
});
