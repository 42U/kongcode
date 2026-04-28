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
import {
  PROTOCOL_VERSION,
  DEFAULT_DAEMON_SOCKET_PATH,
  DEFAULT_DAEMON_TCP_PORT,
  DAEMON_PID_FILE,
  type MetaHandshakeResponse,
  type MetaHealthResponse,
  type ToolOrHookRequest,
} from "../shared/ipc-types.js";
import { DaemonServer } from "./server.js";
import { log } from "../engine/log.js";
import { parsePluginConfig } from "../engine/config.js";
import { bootstrap, resolvePluginDir, shutdownManagedSurreal } from "../engine/bootstrap.js";
import { SurrealStore } from "../engine/surreal.js";
import { EmbeddingService } from "../engine/embeddings.js";
import { GlobalPluginState } from "../engine/state.js";
import { handleIntrospect } from "../tools/introspect.js";

/** Daemon version reported via meta.handshake — kept in sync with package.json. */
const DAEMON_VERSION = "0.7.0-dev";

type BootstrapPhase = MetaHandshakeResponse["bootstrapPhase"];
let bootstrapPhase: BootstrapPhase = "starting";
let bootstrapError: { message: string; stack?: string } | null = null;
const startedAt = Date.now();

/** Module-level state — once initialized, every IPC handler closes over this.
 *  Mirrors mcp-server.ts's globalState pattern but lives in the daemon now. */
let globalState: GlobalPluginState | null = null;

function setBootstrapPhase(p: BootstrapPhase, err?: Error): void {
  bootstrapPhase = p;
  if (p === "failed" && err) {
    bootstrapError = { message: err.message, stack: err.stack };
  }
}

/** Initialize the daemon's state stack — bootstrap, SurrealStore, EmbeddingService,
 *  GlobalPluginState. Equivalent to mcp-server.ts:initialize() but hosted in the
 *  daemon process so all clients share one copy of these heavy resources.
 *
 *  Failures degrade rather than abort: a failed bootstrap leaves the daemon up
 *  but tool handlers return errors via globalState being null, just like mcp-server
 *  did. The user-facing surfacing happens through MetaHandshakeResponse's
 *  bootstrapPhase + bootstrapError fields. */
async function initializeStack(): Promise<void> {
  log.info("[daemon] initializing kongcode stack...");
  setBootstrapPhase("starting");

  const config = parsePluginConfig();

  if (process.env.KONGCODE_SKIP_BOOTSTRAP !== "1") {
    setBootstrapPhase("npm-install");
    try {
      const result = await bootstrap({
        pluginDir: resolvePluginDir(),
        cacheDir: config.paths.cacheDir,
        dataDir: config.paths.dataDir,
        modelPath: config.embedding.modelPath,
        surrealBinPathOverride: config.paths.surrealBinPath,
        surrealUrlOverride: process.env.SURREAL_URL,
        surrealUser: config.surreal.user,
        surrealPass: config.surreal.pass,
      });
      if (result.surrealServer.managed || result.surrealServer.url) {
        // Bootstrap may have detected an existing kongcode SurrealDB on a
        // legacy port (8000/8042) and returned its URL. Either way, point
        // the store at whatever bootstrap chose.
        (config.surreal as { url: string }).url = result.surrealServer.url;
      }
      log.info(
        `[bootstrap] complete in ${result.totalDurationMs}ms ` +
          `(npm=${result.npmInstall.ran ? "ran" : "skip"}, ` +
          `surreal=${result.surrealBinary.provisioned ? "downloaded" : "cached"}, ` +
          `llama=${result.nodeLlamaCpp.mainPath ? (result.nodeLlamaCpp.provisioned ? "downloaded" : "cached") : "via-npm"}, ` +
          `model=${result.embeddingModel.provisioned ? "downloaded" : "cached"})`,
      );
    } catch (err) {
      log.error("[bootstrap] failed — daemon entering degraded mode:", err);
      setBootstrapPhase("failed", err instanceof Error ? err : new Error(String(err)));
      return; // No point setting up store/embeddings if bootstrap exploded.
    }
  } else {
    log.info("[bootstrap] skipped (KONGCODE_SKIP_BOOTSTRAP=1)");
  }

  const store = new SurrealStore(config.surreal);
  const embeddings = new EmbeddingService(config.embedding);
  globalState = new GlobalPluginState(config, store, embeddings);
  globalState.workspaceDir = process.env.KONGCODE_PROJECT_DIR ?? process.cwd();

  setBootstrapPhase("connecting-store");
  try {
    await store.initialize();
    log.info("[daemon] SurrealDB connected");
  } catch (err) {
    log.error("[daemon] SurrealDB connection failed — running in degraded mode:", err);
  }

  setBootstrapPhase("loading-embeddings");
  try {
    await embeddings.initialize();
    log.info("[daemon] Embedding model loaded");
  } catch (err) {
    log.error("[daemon] Embedding model failed — vector search disabled:", err);
  }

  setBootstrapPhase("ready");
  log.info("[daemon] kongcode stack ready");
}

function pidFilePath(): string {
  return join(homedir(), DAEMON_PID_FILE);
}

function writeOwnPidFile(): void {
  const path = pidFilePath();
  // mkdir before write — first run on a fresh machine may not have the
  // cache dir yet. Same path 0.6.3 already creates for surreal.pid.
  try {
    require("node:fs").mkdirSync(dirname(path), { recursive: true });
  } catch {}
  writeFileSync(path, String(process.pid), "utf8");
  log.info(`[daemon] wrote pid file ${path} (pid=${process.pid})`);
}

function removeOwnPidFile(): void {
  const path = pidFilePath();
  try {
    if (!existsSync(path)) return;
    const recorded = Number(readFileSync(path, "utf8").trim());
    // Only remove if the file still records OUR pid — protects against
    // racing daemon instances stomping on each other's pid files during
    // a brief restart window.
    if (recorded === process.pid) {
      unlinkSync(path);
      log.info(`[daemon] removed pid file ${path}`);
    }
  } catch (e) {
    log.warn(`[daemon] couldn't remove pid file: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
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
    const resp: MetaHandshakeResponse = {
      daemonVersion: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAt,
      bootstrapPhase,
      bootstrapError,
    };
    return resp;
  });

  server.register("meta.health", async () => {
    const resp: MetaHealthResponse = {
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

  // ── Tool handlers (incremental migration from mcp-server.ts) ──
  //
  // Each handler closes over the module-level globalState (initialized
  // by initializeStack()). The IPC adapter unpacks the standard
  // {sessionId, args} envelope and dispatches to the existing handler
  // function unchanged. Handlers that haven't been migrated yet return
  // HANDLER_ERROR via the dispatcher (no registration = "not bound").

  /** Wrap an existing (state, session, args) → response handler in a
   *  daemon-side IPC adapter. Resolves the per-session state from
   *  globalState's session map (creates a transient one keyed by
   *  sessionId if absent — matches mcp-server.ts's getSession() shape). */
  const wrapToolHandler = (
    handler: (state: GlobalPluginState, session: import("../engine/state.js").SessionState, args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ) => {
    return async (params: unknown) => {
      if (!globalState) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        return {
          content: [{
            type: "text",
            text: `kongcode daemon is still initializing (phase=${bootstrapPhase}, ${elapsed}s elapsed). Try again shortly.`,
          }],
        };
      }
      const env = params as ToolOrHookRequest | undefined;
      const sessionId = env?.sessionId ?? "daemon-default";
      const args = (env?.args ?? {}) as Record<string, unknown>;
      const session = globalState.getOrCreateSession(sessionId, sessionId);
      return await handler(globalState, session, args);
    };
  };

  // First migrated handler — read-only, doesn't depend on hooks firing.
  // Validates the round-trip: client sends tool.introspect, daemon
  // dispatches to handleIntrospect with daemon-owned globalState,
  // returns real DB stats. Subsequent commits migrate the rest.
  server.register("tool.introspect", wrapToolHandler(handleIntrospect));

  // ── Lifecycle ──

  const shutdown = async (signal: string) => {
    log.info(`[daemon] ${signal} — graceful shutdown`);
    await server.close();
    if (globalState) {
      try { await globalState.shutdown(); } catch (e) { log.warn(`[daemon] globalState.shutdown: ${(e as Error).message}`); }
    }
    // Per 0.6.3 architecture: the SurrealDB child is detached and outlives
    // the daemon. Don't kill it here — that's the whole point of Option A.
    shutdownManagedSurreal(); // No-op by default; only acts on explicit force.
    removeOwnPidFile();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await server.listen();
  writeOwnPidFile();

  // Server is up and serving meta.* immediately. Stack initialization runs
  // async — clients that connect during this window see bootstrapPhase
  // progressing through the real lifecycle (npm-install → ... → ready).
  // Tool handlers return "still initializing" until globalState is set.
  initializeStack().catch((err) => {
    log.error("[daemon] initializeStack rejected:", err);
    setBootstrapPhase("failed", err instanceof Error ? err : new Error(String(err)));
  });

  log.info(`[daemon] ready — protocol v${PROTOCOL_VERSION}, daemon v${DAEMON_VERSION}`);
}

main().catch((err) => {
  log.error("[daemon] fatal error:", err);
  bootstrapPhase = "failed";
  bootstrapError = { message: (err as Error).message, stack: (err as Error).stack };
  removeOwnPidFile();
  process.exit(1);
});
