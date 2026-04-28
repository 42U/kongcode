/**
 * kongcode-daemon entry point.
 *
 * Long-lived background process spawned by the first kongcode-mcp client
 * that doesn't find an existing daemon. Owns SurrealStore, EmbeddingService,
 * ACAN weights, hook event queue, and all tool/hook handlers. Outlives any
 * individual Claude Code session — plugin updates restart only the thin
 * client, never this daemon (unless the binary itself changed).
 *
 * Lifecycle:
 *   1. Acquire spawn lock (prevents two clients from racing to fork two daemons).
 *   2. Verify no other daemon is alive (PID file + ping).
 *   3. Run bootstrap — provision SurrealDB binary + child, BGE-M3 model,
 *      node-llama-cpp native binding. Same logic as 0.6.x mcp-server but
 *      hosted in the daemon process.
 *   4. Initialize SurrealStore + EmbeddingService.
 *   5. Register IPC handlers for every method in IPC_METHODS.
 *   6. Open IPC socket(s). Write PID file. Drop spawn lock.
 *   7. Serve requests until SIGTERM or `meta.shutdown`.
 *
 * Handlers in this initial scaffold are stubs — meta.handshake works,
 * everything else returns a "not yet implemented" error. Subsequent
 * commits migrate tool/hook handlers from the legacy mcp-server.ts.
 */
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PROTOCOL_VERSION, DEFAULT_DAEMON_SOCKET_PATH, DEFAULT_DAEMON_TCP_PORT, DAEMON_PID_FILE, } from "../shared/ipc-types.js";
import { DaemonServer } from "./server.js";
import { log } from "../engine/log.js";
/** Daemon version reported via meta.handshake — kept in sync with package.json. */
const DAEMON_VERSION = "0.7.0-dev";
let bootstrapPhase = "starting";
let bootstrapError = null;
const startedAt = Date.now();
function pidFilePath() {
    return join(homedir(), DAEMON_PID_FILE);
}
function writeOwnPidFile() {
    const path = pidFilePath();
    // mkdir before write — first run on a fresh machine may not have the
    // cache dir yet. Same path 0.6.3 already creates for surreal.pid.
    try {
        require("node:fs").mkdirSync(dirname(path), { recursive: true });
    }
    catch { }
    writeFileSync(path, String(process.pid), "utf8");
    log.info(`[daemon] wrote pid file ${path} (pid=${process.pid})`);
}
function removeOwnPidFile() {
    const path = pidFilePath();
    try {
        if (!existsSync(path))
            return;
        const recorded = Number(readFileSync(path, "utf8").trim());
        // Only remove if the file still records OUR pid — protects against
        // racing daemon instances stomping on each other's pid files during
        // a brief restart window.
        if (recorded === process.pid) {
            unlinkSync(path);
            log.info(`[daemon] removed pid file ${path}`);
        }
    }
    catch (e) {
        log.warn(`[daemon] couldn't remove pid file: ${e.message}`);
    }
}
async function main() {
    log.info(`[daemon] starting kongcode-daemon ${DAEMON_VERSION} (pid=${process.pid})`);
    // Resolve socket / port from env with sensible defaults.
    const socketPath = process.env.KONGCODE_DAEMON_SOCKET ?? DEFAULT_DAEMON_SOCKET_PATH;
    const tcpPortEnv = process.env.KONGCODE_DAEMON_PORT;
    const tcpPort = tcpPortEnv ? Number(tcpPortEnv) : DEFAULT_DAEMON_TCP_PORT;
    // Disable Unix socket if explicitly told to (Windows or paranoid setups).
    const useUds = process.env.KONGCODE_DAEMON_TRANSPORT !== "tcp" && process.platform !== "win32";
    const server = new DaemonServer({
        socketPath: useUds ? socketPath : null,
        tcpPort: Number.isFinite(tcpPort) && tcpPort > 0 ? tcpPort : null,
        log: {
            info: (m) => log.info(m),
            warn: (m) => log.warn(m),
            error: (m, e) => log.error(m, e),
        },
    });
    // ── Meta handlers (always available, no bootstrap dependency) ──
    server.register("meta.handshake", async () => {
        const resp = {
            daemonVersion: DAEMON_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            startedAt,
            bootstrapPhase,
            bootstrapError,
        };
        return resp;
    });
    server.register("meta.health", async () => {
        const resp = {
            ok: true,
            stats: server.getStats(),
        };
        return resp;
    });
    server.register("meta.shutdown", async () => {
        log.info("[daemon] shutdown requested via meta.shutdown");
        // Detach the actual exit so we can return a response first.
        setImmediate(async () => {
            await server.close();
            removeOwnPidFile();
            process.exit(0);
        });
        return { ok: true };
    });
    // ── Tool/hook handlers — registered as stubs in this scaffold ──
    //
    // Each method in IPC_METHODS that isn't `meta.*` returns a
    // "not yet implemented" error until subsequent commits migrate
    // the real handlers. Doing it this way means clients can connect
    // and discover available capability via attempted RPC; the
    // protocol is in place even though the implementations aren't.
    // (Skipping registration entirely would also work — the dispatcher
    // returns HANDLER_ERROR for unregistered known methods.)
    // ── Lifecycle ──
    process.on("SIGTERM", async () => {
        log.info("[daemon] SIGTERM — graceful shutdown");
        await server.close();
        removeOwnPidFile();
        process.exit(0);
    });
    process.on("SIGINT", async () => {
        log.info("[daemon] SIGINT — graceful shutdown");
        await server.close();
        removeOwnPidFile();
        process.exit(0);
    });
    await server.listen();
    writeOwnPidFile();
    bootstrapPhase = "ready"; // No bootstrap yet in this scaffold; once we
    // host SurrealStore + Embeddings here, this
    // will move through the real phases.
    log.info(`[daemon] ready — protocol v${PROTOCOL_VERSION}, daemon v${DAEMON_VERSION}`);
}
main().catch((err) => {
    log.error("[daemon] fatal error:", err);
    bootstrapPhase = "failed";
    bootstrapError = { message: err.message, stack: err.stack };
    removeOwnPidFile();
    process.exit(1);
});
