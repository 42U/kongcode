/**
 * Auto-drain scheduler — restores the auto-extraction behavior that lived in
 * the in-process MemoryDaemon before commit 4f7b962 (2026-04-07) removed the
 * Anthropic SDK. Instead of the daemon making its own LLM calls, we shell
 * out to `claude --agent kongcode:memory-extractor -p "..."` which invokes
 * the existing subagent definition via the user's already-authenticated
 * Claude Code CLI.
 *
 * Triggers:
 *   - Daemon startup (one-shot if queue > threshold)
 *   - Periodic timer (default 5min)
 *   - SessionEnd hook (debounced)
 *
 * Safety:
 *   - PID-file lock at <cacheDir>/auto-drain.pid prevents overlapping spawns
 *   - Threshold gate prevents draining tiny queues
 *   - claude binary lookup with graceful fallback (logs warning, self-disables)
 *
 * Env-var overrides:
 *   KONGCODE_AUTO_DRAIN=0          → disable scheduler entirely
 *   KONGCODE_AUTO_DRAIN_THRESHOLD  → min queue size to trigger (default 5)
 *   KONGCODE_AUTO_DRAIN_INTERVAL_MS → periodic check cadence (default 300_000)
 *   KONGCODE_CLAUDE_BIN            → explicit path to claude binary
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../engine/log.js";
import { swallow } from "../engine/errors.js";
let schedulerStarted = false;
let claudeBinPath = null;
let claudeBinUnavailable = false;
/** Look up the claude binary — env override, then PATH, then known locations.
 *  Cached after first lookup. Returns null if not findable; caller should
 *  log once and self-disable. */
function findClaudeBin() {
    if (claudeBinPath)
        return claudeBinPath;
    if (claudeBinUnavailable)
        return null;
    const envOverride = process.env.KONGCODE_CLAUDE_BIN;
    if (envOverride && existsSync(envOverride)) {
        claudeBinPath = envOverride;
        return claudeBinPath;
    }
    // Try `which claude` first — fastest and respects user's PATH.
    try {
        const which = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 2000 }).trim();
        if (which && existsSync(which)) {
            claudeBinPath = which;
            return claudeBinPath;
        }
    }
    catch { /* fall through */ }
    // Common installation paths.
    const candidates = [
        join(homedir(), ".local/bin/claude"),
        "/usr/local/bin/claude",
        "/opt/claude/bin/claude",
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            claudeBinPath = c;
            return claudeBinPath;
        }
    }
    claudeBinUnavailable = true;
    return null;
}
function pidFilePath(cacheDir) {
    return join(cacheDir, "auto-drain.pid");
}
function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
/** Try to acquire the auto-drain lock. Returns the fd on success, or null
 *  if another extractor is already running (live PID in lock file). Stale
 *  locks (dead PID) are auto-cleaned. */
function tryAcquireLock(lockPath) {
    try {
        return openSync(lockPath, "wx", 0o644);
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
        try {
            const holderPid = Number(readFileSync(lockPath, "utf-8").trim());
            if (!isPidAlive(holderPid)) {
                unlinkSync(lockPath);
                try {
                    return openSync(lockPath, "wx", 0o644);
                }
                catch { }
            }
        }
        catch { }
        return null;
    }
}
function releaseLock(fd, lockPath) {
    try {
        closeSync(fd);
    }
    catch { }
    try {
        unlinkSync(lockPath);
    }
    catch { }
}
async function getPendingCount(state) {
    if (!state.store.isAvailable())
        return 0;
    try {
        const rows = await state.store.queryFirst(`SELECT count() AS count FROM pending_work WHERE status = "pending" GROUP ALL`);
        return rows[0]?.count ?? 0;
    }
    catch (e) {
        swallow.warn("auto-drain:countQuery", e);
        return 0;
    }
}
const DRAIN_PROMPT = "Drain the KongCode pending_work queue. Loop: call mcp__plugin_kongcode_kongcode__fetch_pending_work " +
    "to claim the next item, analyze the data per the work-type instructions, then call " +
    "mcp__plugin_kongcode_kongcode__commit_work_results with your output. Repeat until fetch_pending_work " +
    "returns empty. Be efficient: minimize per-item analysis. This is auto-drain, not user-facing — " +
    "produce no narration, just process items.";
/** Spawn one headless extractor. Returns immediately after fork+unref —
 *  the subprocess runs in the background and exits when it's drained the
 *  queue (or hit its own tool budget cap). */
async function spawnHeadlessDrainer(state, opts, reason) {
    const claudeBin = findClaudeBin();
    if (!claudeBin) {
        return { spawned: false, reason: "claude binary not found (set KONGCODE_CLAUDE_BIN)" };
    }
    const count = await getPendingCount(state);
    if (count < opts.threshold) {
        return { spawned: false, reason: `queue=${count} < threshold=${opts.threshold}` };
    }
    const lockPath = pidFilePath(opts.cacheDir);
    const lockFd = tryAcquireLock(lockPath);
    if (lockFd === null) {
        return { spawned: false, reason: "another extractor already running" };
    }
    log.info(`[auto-drain] spawning headless extractor (queue=${count}, reason=${reason})`);
    try {
        const child = spawn(claudeBin, [
            "--agent", "kongcode:memory-extractor",
            "--print",
            "--output-format", "text",
            "--permission-mode", "bypassPermissions",
            DRAIN_PROMPT,
        ], {
            detached: true,
            stdio: "ignore",
            env: process.env,
        });
        if (typeof child.pid !== "number") {
            releaseLock(lockFd, lockPath);
            return { spawned: false, reason: "spawn returned no pid" };
        }
        try {
            writeSync(lockFd, String(child.pid));
        }
        catch { }
        try {
            closeSync(lockFd);
        }
        catch { }
        child.unref();
        // Watch for exit so we can clean the lock file. Detached + unref'd means
        // the daemon won't block on this, but we still want to know when it's done.
        child.on("exit", (code) => {
            log.info(`[auto-drain] extractor pid=${child.pid} exited with code=${code}`);
            try {
                unlinkSync(lockPath);
            }
            catch { }
        });
        child.on("error", (err) => {
            log.error(`[auto-drain] extractor pid=${child.pid} error:`, err);
            try {
                unlinkSync(lockPath);
            }
            catch { }
        });
        return { spawned: true };
    }
    catch (e) {
        releaseLock(lockFd, lockPath);
        log.error("[auto-drain] spawn failed:", e);
        return { spawned: false, reason: e.message };
    }
}
/** Start the periodic drain scheduler. Idempotent — calling twice is a no-op. */
export function startDrainScheduler(state, opts) {
    if (schedulerStarted)
        return;
    if (process.env.KONGCODE_AUTO_DRAIN === "0") {
        log.info("[auto-drain] disabled by KONGCODE_AUTO_DRAIN=0");
        return;
    }
    schedulerStarted = true;
    // Startup check — fire immediately if there's a backlog.
    spawnHeadlessDrainer(state, opts, "startup")
        .then(r => {
        if (!r.spawned && r.reason)
            log.info(`[auto-drain] startup check: skip (${r.reason})`);
    })
        .catch(e => swallow.warn("auto-drain:startup", e));
    // Periodic check.
    if (opts.intervalMs > 0) {
        const timer = setInterval(() => {
            spawnHeadlessDrainer(state, opts, "periodic")
                .then(r => {
                if (r.spawned)
                    log.info(`[auto-drain] periodic spawn`);
            })
                .catch(e => swallow.warn("auto-drain:periodic", e));
        }, opts.intervalMs);
        timer.unref?.();
    }
}
/** Event-driven trigger — call from SessionEnd handler after items get queued. */
export function triggerDrainCheck(state, opts, reason = "session-end") {
    if (process.env.KONGCODE_AUTO_DRAIN === "0")
        return;
    spawnHeadlessDrainer(state, opts, reason)
        .then(r => {
        if (r.spawned)
            log.info(`[auto-drain] event-driven spawn (${reason})`);
    })
        .catch(e => swallow.warn("auto-drain:trigger", e));
}
