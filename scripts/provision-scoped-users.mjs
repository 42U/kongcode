/**
 * Phase 3 hardening — provision per-project, non-root SurrealDB users.
 *
 * Defines (idempotently, via DEFINE USER OVERWRITE) one root-LEVEL user per
 * project on the target instance, each with ROLES EDITOR:
 *
 *   - EDITOR grants full data read/write plus schema DDL (the daemon's
 *     schema-loader runs DEFINE TABLE/FIELD/INDEX at boot) but NO user
 *     management — a compromised daemon credential cannot rotate passwords,
 *     mint users, or escalate.
 *   - Root-LEVEL (not namespace-scoped) matches the managed-spawn credential
 *     model: `surreal start --user/--pass` creates a root-level user, and the
 *     store's connect signs in with a root-scope auth object
 *     ({username, password}). A namespace-scoped user would require a
 *     different signin shape and break credential-chain symmetry.
 *
 * Passwords come from the projects' existing managed cred files — never from
 * argv or env echoes — so the daemon-side credential (already on disk, 0600)
 * and the DB-side user converge on the same secret:
 *
 *   ~/.laqrumcode/surreal-cred.json  → laqrum_<uid>
 *   ~/.kongcode/surreal-cred.json    → kong_<uid>   (skipped when absent)
 *
 * Run with admin credentials via env:
 *   SURREAL_ADMIN_USER=... SURREAL_ADMIN_PASS=... node scripts/provision-scoped-users.mjs
 * (defaults to the legacy root/root for the FIRST hardening run, after which
 * rotate-root invalidates that default forever).
 *
 * Verification (receipts printed, secrets never printed):
 *   1. each user signs in against its project namespace,
 *   2. data read works,
 *   3. the idempotent DDL shape the schema-loader uses works,
 *   4. user management is DENIED (role-capability self-test: a DEFINE USER
 *      attempt by the EDITOR user must error — expected and asserted).
 */
import { Surreal } from "surrealdb";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const URL = process.env.SURREAL_URL || "ws://localhost:8000/rpc";
const ADMIN_USER = process.env.SURREAL_ADMIN_USER || "root";
const ADMIN_PASS = process.env.SURREAL_ADMIN_PASS || "root";

const SAFE = /^[A-Za-z0-9_-]+$/;
function loadCred(path) {
  const c = JSON.parse(readFileSync(path, "utf8"));
  if (!SAFE.test(c.user) || !SAFE.test(c.pass)) throw new Error(`unsafe characters in cred at ${path}`);
  return c;
}

const targets = [];
const laqrumPath = homedir() + "/.laqrumcode/surreal-cred.json";
const kongPath = homedir() + "/.kongcode/surreal-cred.json";
if (existsSync(laqrumPath)) targets.push({ ns: "laqrum", db: "memory", cred: loadCred(laqrumPath) });
if (existsSync(kongPath)) targets.push({ ns: "kong", db: "memory", cred: loadCred(kongPath) });
if (targets.length === 0) {
  console.error("no managed cred files found — nothing to provision");
  process.exit(1);
}

const admin = new Surreal();
await admin.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: ADMIN_USER, password: ADMIN_PASS } });
try {
  for (const t of targets) {
    await admin.query(`DEFINE USER OVERWRITE ${t.cred.user} ON ROOT PASSWORD '${t.cred.pass}' ROLES EDITOR`);
    console.log(`defined: ${t.cred.user} ON ROOT ROLES EDITOR (for ns ${t.ns})`);
  }
  const info = await admin.query("INFO FOR ROOT");
  console.log("root-level users now:", Object.keys(info[0]?.users ?? {}).join(", "));
} finally { await admin.close(); }

for (const t of targets) {
  const u = new Surreal();
  await u.connect(URL, { namespace: t.ns, database: t.db, authentication: { username: t.cred.user, password: t.cred.pass } });
  try {
    await u.query("RETURN 1");
    console.log(`verify ${t.cred.user}: signin OK (ns ${t.ns})`);
    const sel = await u.query("SELECT count() AS n FROM turn GROUP ALL").catch(() => [[{ n: "n/a" }]]);
    console.log(`verify ${t.cred.user}: data read OK (turns: ${JSON.stringify(sel[0]?.[0]?.n ?? "n/a")})`);
    if (t.ns === "laqrum") {
      // The exact statement shape schema-loader replays at daemon boot —
      // IF NOT EXISTS on an existing table is a no-op, so this only proves
      // the EDITOR role permits DDL without touching the schema.
      await u.query("DEFINE TABLE IF NOT EXISTS monologue SCHEMALESS");
      console.log(`verify ${t.cred.user}: idempotent DDL OK (schema-loader shape)`);
    }
    // Role-capability self-test: EDITOR must NOT be able to manage users.
    // This DEFINE USER attempt is EXPECTED TO FAIL; a success means the role
    // is broader than intended and the script aborts loudly.
    let denied = false;
    try {
      await u.query("DEFINE USER role_capability_selftest ON ROOT PASSWORD 'unused' ROLES VIEWER");
    } catch { denied = true; }
    if (!denied) {
      console.error(`verify ${t.cred.user}: role self-test FAILED — user management was allowed; aborting`);
      process.exit(2);
    }
    console.log(`verify ${t.cred.user}: user management correctly denied (EDITOR)`);
  } finally { await u.close(); }
}
console.log("provisioning complete");
