#!/usr/bin/env node
/**
 * Open the laqrumcode read-only web UI (GH #15) in the default browser.
 *
 * Reads the daemon's auth token (~/.laqrumcode/cache/auth-token, written by
 * src/http-api.ts), mints a SINGLE-USE 60s nonce over the Bearer-authed
 * loopback API (POST /ui/mint), and opens /ui/auth?nonce=… which sets an
 * HttpOnly cookie and redirects to the app. The master token never appears
 * in a URL, argv, or browser history — only the one-shot nonce does
 * (LAQ-SEC-001).
 *
 * Port: imported directly from uiPort() in dist/ui-server.js — the single
 * source of truth the daemon binds with (LAQRUMCODE_UI_PORT override, else the
 * UID-offset default). Loopback only. Never recompute the port here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { platform, homedir } from "node:os";
// V1: single source of truth for the UI port — the SAME uiPort() the daemon
// binds with (dist/ui-server.js, value-imports only node builtins + the tiny
// logger). Round-9 U1 moved the base 28900→33000 in ui-server.ts but this
// launcher kept a duplicated 28900 literal, so the default-config UI opened on
// the wrong port (and would hand the bearer token to whatever held the stale
// one). Importing the function eliminates the duplication for good.
import { uiPort } from "../dist/ui-server.js";

const tokenPath = join(homedir(), ".laqrumcode", "cache", "auth-token");
let token;
try {
  token = readFileSync(tokenPath, "utf8").trim();
} catch {
  console.error(`No auth token at ${tokenPath}.`);
  console.error("The laqrumcode daemon writes it on start — trigger the daemon with any laqrumcode MCP call (e.g. memory_health), then retry.");
  process.exit(1);
}
if (!token) {
  console.error(`Auth token at ${tokenPath} is empty — is the daemon healthy?`);
  process.exit(1);
}

const port = uiPort();

// LAQ-SEC-001: never put the master token in a URL — it would transit the
// opener's argv (world-readable via /proc/*/cmdline on multi-user hosts),
// this terminal, and browser history. Instead mint a SINGLE-USE, 60s nonce
// over the Bearer-authed loopback API; the URL then carries only a value
// that is dead after first use.
let nonce;
try {
  const resp = await fetch(`http://127.0.0.1:${port}/ui/mint`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`mint failed: HTTP ${resp.status}`);
  ({ nonce } = await resp.json());
  if (!nonce) throw new Error("mint returned no nonce");
} catch (e) {
  console.error(`Could not reach the laqrumcode UI on port ${port}: ${e?.message ?? e}`);
  console.error("Is the daemon running? Trigger it with any laqrumcode MCP call (e.g. memory_health), then retry.");
  process.exit(1);
}
const url = `http://127.0.0.1:${port}/ui/auth?nonce=${nonce}`;

console.log(`laqrumcode web UI → http://127.0.0.1:${port}/ui`);
console.log("Opening your browser…  (if it doesn't open, paste this single-use URL within 60s):");
console.log(`  ${url}`);

const opener =
  platform() === "darwin" ? "open" :
  platform() === "win32" ? "cmd" :
  "xdg-open";
const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
try {
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
} catch (e) {
  console.error("Could not auto-open a browser:", e?.message ?? e);
  console.error("Open the URL above manually.");
}
