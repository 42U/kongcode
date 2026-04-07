/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import type { GlobalPluginState } from "./engine/state.js";
import { log } from "./engine/log.js";

let server: HttpServer | null = null;
let socketPath: string | null = null;
let portFilePath: string | null = null;

/** Hook response format matching Claude Code's expected output.
 *
 * IMPORTANT: `additionalContext` must be inside `hookSpecificOutput` with a
 * matching `hookEventName` — Claude Code's Zod schema silently strips
 * unknown top-level keys. Top-level fields are only: continue,
 * suppressOutput, decision, reason, stopReason, systemMessage, hookSpecificOutput.
 */
export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  /** Warning shown in UI — NOT sent to the model. */
  systemMessage?: string;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
  /** For Stop hooks: approve or block the stop. */
  decision?: "approve" | "block";
  reason?: string;
}

/** Helper: wrap additionalContext in the hookSpecificOutput envelope Claude Code expects. */
export function makeHookOutput(eventName: string, additionalContext?: string, extra?: Record<string, unknown>): HookResponse {
  if (!additionalContext && !extra) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
      ...extra,
    },
  };
}

type HookHandler = (
  state: GlobalPluginState,
  payload: Record<string, unknown>,
) => Promise<HookResponse>;

// Hook handler registry — populated in later phases
const handlers = new Map<string, HookHandler>();

/** Register a hook handler for an event. */
export function registerHookHandler(event: string, handler: HookHandler): void {
  handlers.set(event, handler);
}

async function handleRequest(
  state: GlobalPluginState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Hook endpoints: POST /hook/<event-name>
  if (req.method === "POST" && req.url?.startsWith("/hook/")) {
    const event = req.url.slice("/hook/".length);

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      // Empty or invalid JSON — use empty payload
    }

    // Find handler
    const handler = handlers.get(event);
    if (!handler) {
      // No handler registered — pass through (allow)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    try {
      const response = await handler(state, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      log.error(`Hook handler error [${event}]:`, err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}"); // Fail open
    }
    return;
  }

  // Unknown route
  res.writeHead(404);
  res.end("Not found");
}

/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export async function startHttpApi(
  state: GlobalPluginState,
  sock?: string,
  projectDir?: string,
): Promise<void> {
  server = createServer((req, res) => {
    handleRequest(state, req, res).catch(err => {
      log.error("HTTP API error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal error");
      }
    });
  });

  if (sock) {
    // Clean up stale socket file
    if (existsSync(sock)) {
      try { unlinkSync(sock); } catch { /* ignore */ }
    }
    socketPath = sock;
    try {
      await new Promise<void>((resolve, reject) => {
        server!.listen(sock, () => {
          log.info(`HTTP API listening on Unix socket: ${sock}`);
          resolve();
        });
        server!.on("error", reject);
      });
      return;
    } catch (err) {
      log.warn(`Unix socket failed, falling back to TCP:`, err);
      socketPath = null;
    }
  }

  // Fallback: random port — write port file so hook proxy can discover us
  await new Promise<void>((resolve, reject) => {
    server!.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") {
        log.info(`HTTP API listening on port ${addr.port}`);
        const dir = projectDir || process.cwd();
        portFilePath = `${dir}/.kongcode-port`;
        try {
          writeFileSync(portFilePath, String(addr.port));
          log.info(`Port file written: ${portFilePath}`);
        } catch (e) {
          log.warn(`Failed to write port file:`, e);
        }
      }
      resolve();
    });
    server!.on("error", reject);
  });
}

/** Stop the internal HTTP API and clean up socket/port files. */
export async function stopHttpApi(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (socketPath && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    socketPath = null;
  }
  if (portFilePath && existsSync(portFilePath)) {
    try { unlinkSync(portFilePath); } catch { /* ignore */ }
    portFilePath = null;
  }
}
