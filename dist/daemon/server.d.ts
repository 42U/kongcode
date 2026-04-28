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
import { type IpcMethod } from "../shared/ipc-types.js";
/** Handler signature — every IPC method registers one of these. The dispatcher
 *  calls it with the parsed `params` object (already validated as JSON-RPC
 *  shape) and returns whatever the handler resolves to. */
export type IpcHandler = (params: unknown) => Promise<unknown>;
export interface DaemonServerOpts {
    /** Unix socket path or null for TCP-only mode. */
    socketPath: string | null;
    /** TCP loopback port or null for Unix-socket-only mode. Recommend always
     *  enabling — provides a Windows-friendly fallback even on Unix hosts. */
    tcpPort: number | null;
    /** Logger — daemon's main module wires this to its log facility. */
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string, e?: unknown) => void;
    };
}
export declare class DaemonServer {
    private readonly opts;
    private udsServer;
    private tcpServer;
    private handlers;
    private clients;
    private rpcsServedTotal;
    private rpcsInFlight;
    private startedAt;
    constructor(opts: DaemonServerOpts);
    /** Register a handler for an IPC method. The dispatcher rejects calls to
     *  methods that aren't both in IPC_METHODS (compile-time) AND registered
     *  here (runtime) — covers the case where the constants list outpaces
     *  actual implementations during incremental rollout. */
    register(method: IpcMethod, handler: IpcHandler): void;
    /** Start listening. Throws if the socket can't be bound (e.g. another
     *  daemon already running on the same path — caller should detect via
     *  the spawn lock + PID file probe before calling listen()). */
    listen(): Promise<void>;
    /** Drain in-flight requests, close listeners, close client sockets, exit.
     *  Caller (daemon main) is responsible for closing SurrealStore and
     *  saving any pending state before this is called. */
    close(): Promise<void>;
    /** Stats surfaced via meta.health for ops visibility. */
    getStats(): {
        activeClients: number;
        activeSessions: number;
        rpcsServedTotal: number;
        rpcsInFlight: number;
        startedAt: number;
        protocolVersion: number;
    };
    private onConnection;
    private dispatchLine;
    private sendResponse;
}
