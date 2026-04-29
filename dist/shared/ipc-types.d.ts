/**
 * IPC contract between kongcode-daemon and kongcode-mcp (the per-Claude-Code
 * client). This file is the single source of truth for what RPC methods
 * exist, what they accept, and what they return.
 *
 * Architecture (v0.7.0+):
 *   kongcode-mcp (thin client, one per Claude Code session)
 *     └── stdio  ── Claude Code (MCP protocol)
 *     └── socket ── kongcode-daemon (JSON-RPC over Unix socket / TCP)
 *
 * The daemon owns SurrealStore, EmbeddingService, ACAN weights, hook handlers,
 * and tool handlers. Clients are stateless relays that translate Claude Code's
 * MCP RPC into our IPC RPC. Multiple clients (multiple Claude Code sessions)
 * connect to one daemon; the daemon serializes per-session state via the
 * sessionId carried on every call.
 *
 * Wire format: JSON-RPC 2.0. Methods are namespaced — `tool.<name>` for MCP
 * tool handlers, `hook.<name>` for Claude Code hook events, `meta.<name>`
 * for daemon-level operations.
 *
 * Versioning: bump PROTOCOL_VERSION on any breaking change. The daemon
 * advertises its supported version in `meta.handshake`; clients refuse to
 * proceed against incompatible daemons (forces daemon restart with new
 * binary on plugin update).
 */
/** Bumped on any breaking IPC change. Clients and daemons compare on connect. */
export declare const PROTOCOL_VERSION = 1;
/** Default Unix socket path (Linux, macOS). Single shared daemon socket
 *  replaces 0.6.x's per-PID `~/.kongcode-${pid}.sock` pattern. */
export declare const DEFAULT_DAEMON_SOCKET_PATH: string;
/** Default TCP fallback port (Windows or where Unix sockets are fragile).
 *  Loopback only. Override via KONGCODE_DAEMON_PORT. */
export declare const DEFAULT_DAEMON_TCP_PORT = 18764;
/** Daemon PID file location. Written on daemon startup, removed on graceful
 *  shutdown. Used by clients to detect "daemon was running but crashed" vs
 *  "daemon never started." */
export declare const DAEMON_PID_FILE = ".kongcode/cache/daemon.pid";
/** Lock file held during daemon spawn. Prevents two clients from racing to
 *  fork two daemons simultaneously. */
export declare const DAEMON_SPAWN_LOCK = ".kongcode/cache/daemon.spawn.lock";
/** Every RPC carries the originating Claude Code session id so the daemon
 *  can route per-session state (SessionState in its in-memory map). */
export interface IpcEnvelope {
    sessionId: string;
}
/** Standard error codes the daemon may return. Clients translate these into
 *  appropriate MCP responses or retry/restart behavior. */
export declare const enum IpcErrorCode {
    /** Daemon is mid-bootstrap, downloading deps. Client should retry with backoff. */
    DAEMON_BOOTSTRAPPING = -32001,
    /** Daemon died and is restarting. Client should reconnect after backoff. */
    DAEMON_RESTARTING = -32002,
    /** Tool/hook handler raised — daemon couldn't process. Treated as user-visible. */
    HANDLER_ERROR = -32003,
    /** Protocol version mismatch — client should refuse to talk to this daemon. */
    PROTOCOL_VERSION_MISMATCH = -32004,
    /** Session id not registered with daemon (race during reconnect). Client should re-register. */
    UNKNOWN_SESSION = -32005
}
/** Generic tool/hook payload — keys are the args the existing handlers accept.
 *  Kept loose to mirror the existing handler signatures; tightening this
 *  to per-method types is a stretch goal. */
export type IpcPayload = Record<string, unknown>;
/** Standard response shape — mirrors the MCP tool response envelope so the
 *  client can pass it through with minimal translation. */
export interface IpcResponse {
    content?: Array<{
        type: "text";
        text: string;
    }>;
    /** Set by hook handlers — passes through to Claude Code's hook output. */
    hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
    };
}
/** Every registered IPC method. Used by the daemon's dispatcher and the
 *  client's stub library. Adding a method requires:
 *    1. Add the literal here
 *    2. Implement the handler in `src/daemon/handlers.ts`
 *    3. Add a typed wrapper in `src/mcp-client/rpc-stub.ts`
 *  All three live in the same repo, so type errors flag missing wiring. */
export declare const IPC_METHODS: readonly ["meta.handshake", "meta.health", "meta.shutdown", "meta.requestSupersede", "tool.recall", "tool.coreMemory", "tool.introspect", "tool.fetchPendingWork", "tool.commitWorkResults", "tool.createKnowledgeGems", "tool.memoryHealth", "tool.linkHierarchy", "tool.supersede", "tool.recordFinding", "tool.clusterScan", "tool.whatIsMissing", "hook.sessionStart", "hook.userPromptSubmit", "hook.preToolUse", "hook.postToolUse", "hook.stop", "hook.preCompact", "hook.postCompact", "hook.sessionEnd", "hook.taskCreated", "hook.subagentStop"];
export type IpcMethod = typeof IPC_METHODS[number];
/** Type-safety helper: narrows arbitrary strings to known method names at
 *  the dispatcher boundary. Returns null for unknown methods (daemon then
 *  responds with JSON-RPC's standard "Method not found" error -32601). */
export declare function isKnownMethod(name: string): name is IpcMethod;
export interface MetaHandshakeResponse {
    daemonVersion: string;
    protocolVersion: number;
    startedAt: number;
    bootstrapPhase: "starting" | "npm-install" | "downloading-surreal" | "downloading-model" | "starting-surreal" | "connecting-store" | "loading-embeddings" | "ready" | "failed";
    bootstrapError: {
        message: string;
        stack?: string;
    } | null;
}
export interface MetaHealthResponse {
    ok: true;
    /** Counts of recent client connections, in-flight RPCs — surfaced for ops. */
    stats?: {
        activeClients: number;
        activeSessions: number;
        rpcsServedTotal: number;
        rpcsInFlight: number;
    };
}
export interface MetaRequestSupersedeRequest {
    /** Caller's version (e.g. "0.7.7"). Daemon only accepts the supersede
     *  flag when callerVersion is strictly newer than its own DAEMON_VERSION. */
    clientVersion: string;
}
export interface MetaRequestSupersedeResponse {
    /** True if the daemon accepted the supersede request and will exit when
     *  the last client disconnects. False if it rejected (e.g. caller version
     *  is older than or equal to daemon version). */
    accepted: boolean;
    /** Daemon's own version, for the client's logging. */
    daemonVersion: string;
    /** Number of attached clients at the time of request — caller can use
     *  this to decide whether to wait or just continue. */
    attachedClients: number;
}
/** Tool / hook calls — both share the same envelope at the wire level. The
 *  daemon dispatches by method name to the right handler. */
export interface ToolOrHookRequest extends IpcEnvelope {
    args: IpcPayload;
}
/** JSON-RPC framing notes (informational — actual framing handled by transport):
 *
 *  Request:  {"jsonrpc":"2.0", "id":N, "method":"tool.recall", "params":{sessionId, args}}
 *  Response: {"jsonrpc":"2.0", "id":N, "result":{content:[...]} }
 *  Error:    {"jsonrpc":"2.0", "id":N, "error":{code,message,data}}
 *
 *  Transport: line-delimited JSON over Unix socket / TCP (one JSON object per
 *  line). Simpler than length-prefixed; avoids needing a streaming parser.
 *  Each side flushes after \n.
 */
