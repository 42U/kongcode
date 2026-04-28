#!/usr/bin/env node
/**
 * Cross-platform kongcode hook proxy.
 *
 * Replacement for hook-proxy.sh that works on Windows without Git Bash.
 * Forwards Claude Code hook events to the MCP server's internal HTTP API
 * via Unix socket on POSIX, or TCP on Windows (the MCP exposes both).
 *
 * Usage: node hook-proxy.js <event-name>
 *   reads hook payload JSON from stdin, returns hook response JSON on stdout.
 *   fails open (returns "{}") if the MCP server is unreachable, so Claude
 *   Code's pipeline never gets blocked by a broken kongcode install.
 *
 * Discovery (mirrors hook-proxy.sh):
 *   1. Per-PID Unix sockets at $HOME/.kongcode-<pid>.sock — newest-first by
 *      mtime, skip stale (PID dead). POSIX-only.
 *   2. Legacy shared Unix socket at $HOME/.kongcode.sock. POSIX-only.
 *   3. TCP port read from $HOME/.kongcode-port. Cross-platform.
 *
 * Why Node and not bash: hooks.json invokes "bash ..." which fails silently
 * on Windows without Git Bash, leaving sessions/agents/projects/tasks empty.
 * Node is already a kongcode hard prereq (the MCP server runs on it), so
 * routing hooks through Node is the lowest-friction cross-platform fix.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

const HOOK_EVENT = process.argv[2];
if (!HOOK_EVENT) {
  process.stderr.write("hook-proxy: missing event name\n");
  process.exit(1);
}

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TIMEOUT_MS = 10_000; // matches hook-proxy.sh's curl --max-time default

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
    // Don't hang forever if stdin is somehow not closed — Claude Code always
    // closes it after writing the payload, but defensive timeout is cheap.
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 1_000);
  });
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch (e) {
    // EPERM means the PID exists but we don't own it — still alive for our
    // purposes. ESRCH means the PID doesn't exist.
    return e.code === "EPERM";
  }
}

/** Find a per-PID kongcode socket whose owning process is still alive.
 *  Returns the socket path or null. POSIX only — Windows treats Unix
 *  sockets as files but Node's HTTP client over UDS works on Windows 10+
 *  via named pipes or AF_UNIX, which we don't rely on here. */
function findUnixSocket() {
  if (process.platform === "win32") return null;
  let entries;
  try {
    entries = fs.readdirSync(HOME, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.name.startsWith(".kongcode-") && e.name.endsWith(".sock"))
    .map((e) => {
      const full = path.join(HOME, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      const pidStr = e.name.slice(".kongcode-".length, -".sock".length);
      const pid = Number(pidStr);
      return { path: full, mtime, pid };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (isPidAlive(c.pid)) return c.path;
  }
  // Legacy shared socket fallback (pre-0.3.0 MCPs)
  const legacy = path.join(HOME, ".kongcode.sock");
  try { if (fs.statSync(legacy).isSocket()) return legacy; } catch {}
  return null;
}

/** Read the TCP port the MCP wrote on startup. Cross-platform. */
function readPort() {
  try {
    const raw = fs.readFileSync(path.join(HOME, ".kongcode-port"), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

function postJson({ socketPath, port, eventName, body }) {
  return new Promise((resolve) => {
    const opts = socketPath
      ? { socketPath, path: `/${eventName}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }
      : { host: "127.0.0.1", port, path: `/${eventName}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => resolve(""));
    });
    req.on("error", () => resolve("")); // fail-open: empty body, parent treats as {}
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(""); });
    req.write(body);
    req.end();
  });
}

(async () => {
  const payload = await readStdin();
  const sock = findUnixSocket();
  const port = sock ? null : readPort();
  if (!sock && !port) {
    process.stdout.write("{}");
    return;
  }
  const out = await postJson({
    socketPath: sock,
    port,
    eventName: HOOK_EVENT,
    body: payload || "{}",
  });
  process.stdout.write(out || "{}");
})();
