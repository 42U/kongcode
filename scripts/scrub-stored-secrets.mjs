/**
 * LAQ-SEC-005 — surgically replace known secret literals already stored in the
 * graph with the standard redaction placeholder.
 *
 * The ingestion-time redaction (src/engine/redact.ts) prevents NEW storage,
 * but anything captured before a pattern existed persists in turn/memory/
 * concept/monologue rows and every backup taken afterwards. This tool fixes
 * the stored copies:
 *
 *   - Literals are read from STDIN, one per line — never argv (world-readable
 *     via /proc) and never env echoes. e.g.:
 *       jq -r .pass ~/.laqrumcode/surreal-cred.json | node scripts/scrub-stored-secrets.mjs
 *   - Replacement only — no row is deleted; each match becomes
 *     "[redacted-secret-pattern]" via string::replace with the literal BOUND
 *     (never interpolated).
 *   - Per-table before/after match counts are printed as receipts. The
 *     literals themselves are never printed.
 *
 * Caveat: a scrubbed row keeps its original embedding (computed before the
 * scrub). Embeddings are not reversible to the literal, so this is accepted;
 * re-embedding is available via the repair scripts if ever desired.
 *
 * Credentials resolve like every other script: env > managed cred file >
 * legacy default (scripts/surreal-cred.mjs).
 */
import { Surreal } from "surrealdb";
import { resolveScriptCred } from "./surreal-cred.mjs";

const URL = process.env.SURREAL_URL || "ws://localhost:8000/rpc";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";
const PLACEHOLDER = "[redacted-secret-pattern]";

/** table → text-bearing field */
const TARGETS = [
  ["turn", "text"],
  ["turn_archive", "text"],
  ["memory", "text"],
  ["concept", "content"],
  ["monologue", "content"],
];

const stdin = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf));
});
const literals = stdin.split("\n").map((s) => s.trim()).filter((s) => s.length >= 6);
if (literals.length === 0) {
  console.error("no literals on stdin (need >= 6 chars each) — nothing to scrub");
  process.exit(1);
}
console.log(`scrubbing ${literals.length} literal(s) across ${TARGETS.length} tables…`);

const cred = resolveScriptCred();
const db = new Surreal();
await db.connect(URL, { namespace: NS, database: DB, authentication: { username: cred.user, password: cred.pass } });
try {
  let totalBefore = 0;
  for (let i = 0; i < literals.length; i++) {
    const lit = literals[i];
    for (const [table, field] of TARGETS) {
      const [cnt] = await db.query(
        `SELECT count() AS c FROM ${table} WHERE string::contains(${field}, $lit) GROUP ALL`,
        { lit },
      );
      const before = cnt?.[0]?.c ?? 0;
      if (before === 0) continue;
      totalBefore += before;
      await db.query(
        `UPDATE ${table} SET ${field} = string::replace(${field}, $lit, $ph) WHERE string::contains(${field}, $lit)`,
        { lit, ph: PLACEHOLDER },
      );
      const [cnt2] = await db.query(
        `SELECT count() AS c FROM ${table} WHERE string::contains(${field}, $lit) GROUP ALL`,
        { lit },
      );
      const after = cnt2?.[0]?.c ?? 0;
      console.log(`  literal#${i + 1} ${table}.${field}: ${before} row(s) matched → ${after} remaining`);
    }
  }
  console.log(totalBefore === 0
    ? "no stored matches found — graph is already clean for these literals"
    : "scrub complete");
} finally { await db.close(); }
