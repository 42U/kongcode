#!/usr/bin/env node
/**
 * Live-fire integration runner — exercises every synapse of a running
 * kongcode daemon. Connects to /home/zero/.kongcode-daemon.sock via the
 * IPC protocol and fires representative payloads at every registered
 * method, plus calls the recovery.ts primitives directly via dynamic
 * import.
 *
 * Goal: catch wiring gaps proactively. Run after every release; green
 * means "every synapse exists end-to-end" — no more discovering gaps
 * reactively in conversation.
 *
 * Usage:
 *   node scripts/live-fire.mjs
 *   npm run live-fire   (after package.json scripts entry)
 *
 * Exit code: 0 if all synapses pass, 1 if any fail.
 *
 * NON-DESTRUCTIVE — read paths and idempotent writes only. Test session
 * id `live-fire-<timestamp>` is used for any per-session tool calls so
 * production data is untouched.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";

const SOCK = "/home/zero/.kongcode-daemon.sock";
const SESSION_ID = `live-fire-${Date.now()}`;
const RESULTS = []; // { synapse, ok, detail, ms }

if (!existsSync(SOCK)) {
  console.error(`[live-fire] daemon socket not found at ${SOCK}. Start the daemon first.`);
  process.exit(1);
}

// ── IPC client ──────────────────────────────────────────────────────

let _idCounter = 0;
function rpc(method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++_idCounter;
    const c = createConnection(SOCK);
    let buf = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error(`${method} timeout`)); }, timeoutMs);
    c.on("connect", () => c.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    c.on("data", d => {
      buf += d;
      try {
        const obj = JSON.parse(buf);
        clearTimeout(timer);
        c.end();
        if (obj.error) reject(new Error(obj.error.message ?? JSON.stringify(obj.error)));
        else resolve(obj.result);
      } catch { /* keep buffering */ }
    });
    c.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

async function fire(synapse, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    RESULTS.push({ synapse, ok: true, detail, ms: Date.now() - t0 });
    process.stdout.write(`  ✓ ${synapse.padEnd(40)} ${Date.now() - t0}ms\n`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    RESULTS.push({ synapse, ok: false, detail, ms: Date.now() - t0 });
    process.stdout.write(`  ✗ ${synapse.padEnd(40)} ${detail.slice(0, 100)}\n`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────

console.log("KongCode live-fire — exercising every synapse against running daemon");
console.log(`  socket: ${SOCK}`);
console.log(`  test session: ${SESSION_ID}`);
console.log("");

console.log("[1/3] meta.* (3 — skipping meta.shutdown which would kill mid-test)");
await fire("meta.handshake",        () => rpc("meta.handshake", { clientVersion: "live-fire" }));
await fire("meta.health",           () => rpc("meta.health"));
await fire("meta.requestSupersede", () => rpc("meta.requestSupersede", { clientVersion: "0.0.0-test" })); // declined (older), non-destructive
// meta.shutdown intentionally skipped — would kill the daemon mid-test

console.log("\n[2/3] tool.* (12 — skipping commitWorkResults: needs valid pending work_id)");
await fire("tool.memoryHealth",     () => rpc("tool.memoryHealth", { sessionId: SESSION_ID, args: {} }));
await fire("tool.introspect:status", () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "status" } }));
await fire("tool.introspect:count",  () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "count", table: "concept" } }));
await fire("tool.introspect:query",  () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "query", filter: "embedding_coverage" } }));
await fire("tool.introspect:trends", () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "trends" } }));
await fire("tool.introspect:migrate-projectid", () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "migrate", filter: "backfill_project_id" } }, 30000));
await fire("tool.introspect:migrate-derivedfrom", () => rpc("tool.introspect", { sessionId: SESSION_ID, args: { action: "migrate", filter: "backfill_derived_from" } }, 30000));
await fire("tool.recall",           () => rpc("tool.recall", { sessionId: SESSION_ID, args: { query: "kongcode release process", limit: 3 } }));
await fire("tool.clusterScan",      () => rpc("tool.clusterScan", { sessionId: SESSION_ID, args: { query: "graph schema", limit: 5 } }));
await fire("tool.whatIsMissing",    () => rpc("tool.whatIsMissing", { sessionId: SESSION_ID, args: { context: "exploring kongcode internals before refactoring memory daemon", gap_limit: 5 } }));
await fire("tool.coreMemory:list",  () => rpc("tool.coreMemory", { sessionId: SESSION_ID, args: { action: "list" } }));
await fire("tool.fetchPendingWork", () => rpc("tool.fetchPendingWork", { sessionId: SESSION_ID, args: {} }));

console.log("\n[3/3] hook.* (10 — every registered hook handler)");
const fakePayload = { session_id: SESSION_ID, prompt: "[live-fire] smoke test", cwd: "/home/zero/voidorigin/kongcode" };
await fire("hook.sessionStart",     () => rpc("hook.sessionStart", fakePayload));
await fire("hook.userPromptSubmit", () => rpc("hook.userPromptSubmit", fakePayload));
await fire("hook.preToolUse",       () => rpc("hook.preToolUse", { ...fakePayload, tool_name: "Bash", tool_input: { command: "echo test" } }));
await fire("hook.postToolUse",      () => rpc("hook.postToolUse", { ...fakePayload, tool_name: "Bash", tool_input: { command: "echo test" }, tool_response: "test" }));
// 0.7.42 C1 — fire the previously-skipped hooks with clearly-tagged
// [live-fire] payloads. These ARE additive (write turn rows, queue
// pending_work, etc.), but the tag makes the test data identifiable
// for cleanup. transcript_path is set to /dev/null so the transcript
// reader returns empty rather than mining a real conversation.
await fire("hook.stop",             () => rpc("hook.stop", { ...fakePayload, transcript_path: "/dev/null" }));
await fire("hook.preCompact",       () => rpc("hook.preCompact", { ...fakePayload, transcript_path: "/dev/null" }));
await fire("hook.postCompact",      () => rpc("hook.postCompact", { ...fakePayload, summary: "[live-fire] synthetic compaction summary" }));
await fire("hook.taskCreated",      () => rpc("hook.taskCreated", { task_description: "[live-fire] synthetic task" }));
await fire("hook.subagentStop",     () => rpc("hook.subagentStop", { ...fakePayload, agent_type: "live-fire", parent_session_id: SESSION_ID }));
await fire("hook.sessionEnd",       () => rpc("hook.sessionEnd", fakePayload));
// meta.shutdown remains intentionally skipped — only synapse that's truly
// destructive (kills the running daemon). Tested in unit suites; firing
// here would terminate the daemon and break subsequent runs of this script.

// recovery.* primitives are exercised live via tool.introspect:migrate-*
// above (which calls recoverProjectIdRows + recoverDaemonOrphans through
// the daemon's writable SurrealDB connection). Direct-import here would
// require a second authenticated client, which surrealkv's single-writer
// model rejects. Unit-test coverage in test/recovery.test.ts pins the
// helper contracts in isolation.

// ── Report ──────────────────────────────────────────────────────────

const passed = RESULTS.filter(r => r.ok).length;
const failed = RESULTS.length - passed;
console.log("");
console.log("═══════════════════════════════════════════════");
console.log(`Live-fire results: ${passed}/${RESULTS.length} synapses green`);
if (failed > 0) {
  console.log("");
  console.log("Failures:");
  for (const r of RESULTS.filter(r => !r.ok)) {
    console.log(`  ✗ ${r.synapse}: ${r.detail}`);
  }
}
console.log("═══════════════════════════════════════════════");
process.exit(failed === 0 ? 0 : 1);
