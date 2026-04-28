/**
 * Daemon-spawn helper used by kongcode-mcp on startup.
 *
 * Implements the "client starts daemon if missing" lifecycle:
 *   1. Probe socket → if alive, return URL.
 *   2. Probe PID file → if PID alive but socket dead, log warning, fall through
 *      to spawn (daemon was killed mid-life; pid file is stale).
 *   3. Spawn `node <daemon-binary>` detached + unref'd; wait for ready.
 *   4. Return socket path once daemon's meta.handshake responds.
 *
 * Uses a file lock at `<cacheDir>/daemon.lock` to prevent concurrent spawns
 * when multiple Claude Code sessions race on first daemon start.
 */
export interface DaemonSpawnOpts {
    socketPath?: string;
    cacheDir?: string;
    /** Path to dist/daemon/index.js — derived from this file's location if omitted. */
    daemonScriptPath?: string;
    /** Max time to wait for daemon to respond to meta.handshake. Cold first run
     *  takes 3-5 min for downloads; subsequent runs are <5s. */
    readyTimeoutMs?: number;
    log?: {
        info: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string, e?: unknown) => void;
    };
}
/** Get a daemon URL — either the existing one if alive, or spawn a new one. */
export declare function ensureDaemon(opts?: DaemonSpawnOpts): Promise<{
    socketPath: string;
    spawned: boolean;
}>;
