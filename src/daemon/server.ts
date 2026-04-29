/**
 * JSON-RPC 2.0 server for the kongcode daemon.
 *
 * Wire format: line-delimited JSON over Unix socket (Linux, macOS) or TCP
 * loopback (Windows / explicit override). Each direction sends one JSON
 * object per line; receivers buffer until they see \n then parse.
 *
 * Why line-delimited and not length-prefixed: simpler parser, no streaming
 * state machine needed, robust to socket partial reads, and trivial to
 * inspect via `nc -U ~/.kongcode-daemon.sock` for live debugging. Trade-off
 * is that no payload may contain raw newlines — JSON.stringify already
 * escapes \n inside strings so this is a non-issue in practice.
 *
 * Concurrency: each client gets its own socket; per-client requests are
 * dispatched concurrently via Promise. Daemon-internal state (SurrealStore,
 * EmbeddingService) handles its own concurrency.
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  IpcErrorCode,
  isKnownMethod,
  type IpcMethod,
} from "../shared/ipc-types.js";

/** Handler signature — every IPC method registers one of these. The dispatcher
 *  calls it with the parsed `params` object (already validated as JSON-RPC
 *  shape) and returns whatever the handler resolves to. */
export type IpcHandler = (params: unknown) => Promise<unknown>;

/** Standard JSON-RPC 2.0 request shape. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

/** Standard JSON-RPC 2.0 response shape — exactly one of result or error. */
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };

export interface DaemonServerOpts {
  /** Unix socket path or null for TCP-only mode. */
  socketPath: string | null;
  /** TCP loopback port or null for Unix-socket-only mode. Recommend always
   *  enabling — provides a Windows-friendly fallback even on Unix hosts. */
  tcpPort: number | null;
  /** Logger — daemon's main module wires this to its log facility. */
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, e?: unknown) => void };
  /** Called when the supersede flag is set and the last attached client
   *  disconnects. Daemon main wires this to graceful-shutdown logic so a
   *  newer-version client can flag the daemon for exit and have it actually
   *  exit at the natural disconnect boundary, without disrupting other
   *  still-attached older-version clients. */
  onSupersedeReady?: () => void;
}

export class DaemonServer {
  private udsServer: Server | null = null;
  private tcpServer: Server | null = null;
  private handlers = new Map<IpcMethod, IpcHandler>();
  private clients = new Set<Socket>();
  private rpcsServedTotal = 0;
  private rpcsInFlight = 0;
  private startedAt = Date.now();
  private pendingSupersede = false;

  constructor(private readonly opts: DaemonServerOpts) {}

  /** Register a handler for an IPC method. The dispatcher rejects calls to
   *  methods that aren't both in IPC_METHODS (compile-time) AND registered
   *  here (runtime) — covers the case where the constants list outpaces
   *  actual implementations during incremental rollout. */
  register(method: IpcMethod, handler: IpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Start listening. Throws if the socket can't be bound (e.g. another
   *  daemon already running on the same path — caller should detect via
   *  the spawn lock + PID file probe before calling listen()). */
  async listen(): Promise<void> {
    if (this.opts.socketPath) {
      // Stale socket from a previous crashed daemon would prevent bind.
      // Caller (daemon main) should already have verified no live daemon
      // owns the socket via PID file + ping; safe to remove if present.
      if (existsSync(this.opts.socketPath)) {
        try { unlinkSync(this.opts.socketPath); } catch {}
      }
      this.udsServer = createServer((sock) => this.onConnection(sock));
      await new Promise<void>((resolve, reject) => {
        this.udsServer!.once("error", reject);
        this.udsServer!.listen(this.opts.socketPath!, () => {
          this.udsServer!.removeListener("error", reject);
          resolve();
        });
      });
      this.opts.log.info(`[daemon] listening on Unix socket ${this.opts.socketPath}`);
    }
    if (this.opts.tcpPort) {
      this.tcpServer = createServer((sock) => this.onConnection(sock));
      await new Promise<void>((resolve, reject) => {
        this.tcpServer!.once("error", reject);
        // Bind 127.0.0.1 only — never expose the daemon to the network.
        this.tcpServer!.listen(this.opts.tcpPort!, "127.0.0.1", () => {
          this.tcpServer!.removeListener("error", reject);
          resolve();
        });
      });
      this.opts.log.info(`[daemon] listening on TCP 127.0.0.1:${this.opts.tcpPort}`);
    }
  }

  /** Drain in-flight requests, close listeners, close client sockets, exit.
   *  Caller (daemon main) is responsible for closing SurrealStore and
   *  saving any pending state before this is called. */
  async close(): Promise<void> {
    for (const c of this.clients) {
      try { c.end(); } catch {}
    }
    this.clients.clear();
    if (this.udsServer) {
      await new Promise<void>((resolve) => this.udsServer!.close(() => resolve()));
      if (this.opts.socketPath && existsSync(this.opts.socketPath)) {
        try { unlinkSync(this.opts.socketPath); } catch {}
      }
    }
    if (this.tcpServer) {
      await new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()));
    }
  }

  /** Stats surfaced via meta.health for ops visibility. */
  getStats() {
    return {
      activeClients: this.clients.size,
      activeSessions: 0, // populated once handlers track session registry
      rpcsServedTotal: this.rpcsServedTotal,
      rpcsInFlight: this.rpcsInFlight,
      startedAt: this.startedAt,
      protocolVersion: PROTOCOL_VERSION,
      pendingSupersede: this.pendingSupersede,
    };
  }

  /** Number of currently-attached client sockets. Used by meta.requestSupersede
   *  to report whether the daemon is "orphaned" (zero attached). */
  get attachedClientCount(): number {
    return this.clients.size;
  }

  /** Mark daemon for supersede: it will exit when the last attached client
   *  disconnects. Idempotent. Safe to call from a handler thread. */
  markPendingSupersede(): void {
    this.pendingSupersede = true;
  }

  isPendingSupersede(): boolean {
    return this.pendingSupersede;
  }

  /** When supersede is flagged AND the last client just disconnected, fire
   *  the registered callback so daemon main can shut down cleanly. The
   *  callback is invoked exactly once per supersede cycle. */
  private supersedeFired = false;
  private checkSupersedeReady(): void {
    if (
      this.pendingSupersede &&
      !this.supersedeFired &&
      this.clients.size === 0 &&
      this.opts.onSupersedeReady
    ) {
      this.supersedeFired = true;
      this.opts.log.info("[daemon] last client disconnected with supersede flag set — exiting for code refresh");
      try { this.opts.onSupersedeReady(); } catch (e) {
        this.opts.log.warn(`[daemon] onSupersedeReady callback threw: ${(e as Error).message}`);
      }
    }
  }

  // ── Per-connection handling ─────────────────────────────────────

  private onConnection(sock: Socket): void {
    this.clients.add(sock);
    let buffer = "";

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // Process complete lines as they arrive. Partial trailing line stays
      // in buffer for the next data event.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // Don't await — handlers run concurrently per request. The socket
        // remains writable while requests process; responses come back as
        // they're ready, which is fine since each carries its `id`.
        this.dispatchLine(sock, line).catch((e) => {
          this.opts.log.error("[daemon] dispatch error:", e);
        });
      }
    });

    sock.on("close", () => {
      this.clients.delete(sock);
      this.checkSupersedeReady();
    });

    sock.on("error", (err) => {
      // ECONNRESET when client disappears mid-request — common, not worth
      // logging at error level.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNRESET" && code !== "EPIPE") {
        this.opts.log.warn(`[daemon] client socket error: ${err.message}`);
      }
      this.clients.delete(sock);
      this.checkSupersedeReady();
    });
  }

  private async dispatchLine(sock: Socket, line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch (e) {
      // Parse error — JSON-RPC says respond with id:null since we couldn't
      // identify the originating request.
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error", data: (e as Error).message },
      });
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    if (!isKnownMethod(req.method)) {
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
      return;
    }
    const handler = this.handlers.get(req.method);
    if (!handler) {
      // Method is in IPC_METHODS but not yet registered — happens during
      // incremental rollout when constants land before implementations.
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: IpcErrorCode.HANDLER_ERROR,
          message: `Method registered in protocol but no handler bound: ${req.method}`,
        },
      });
      return;
    }
    this.rpcsInFlight++;
    try {
      const result = await handler(req.params);
      this.rpcsServedTotal++;
      this.sendResponse(sock, { jsonrpc: "2.0", id: req.id, result });
    } catch (e) {
      const err = e as Error;
      this.opts.log.warn(`[daemon] handler ${req.method} threw: ${err.message}`);
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: IpcErrorCode.HANDLER_ERROR, message: err.message, data: err.stack },
      });
    } finally {
      this.rpcsInFlight--;
    }
  }

  private sendResponse(sock: Socket, resp: JsonRpcResponse): void {
    if (sock.destroyed || !sock.writable) return;
    try {
      sock.write(JSON.stringify(resp) + "\n");
    } catch (e) {
      this.opts.log.warn(`[daemon] send response failed: ${(e as Error).message}`);
    }
  }
}
