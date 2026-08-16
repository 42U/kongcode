/**
 * Phase 3 hardening — rotate the SurrealDB root credential off the guessable
 * legacy default.
 *
 * Sequence (crash-safe ordering):
 *   1. Generate a strong secret (24 random bytes, base64url).
 *   2. PERSIST it first to ~/.laqrumcode/surreal-admin-cred.json (created
 *      0600) — if the process dies between persist and rotate, the file just
 *      holds an unused secret and the run is retried; the reverse order
 *      could rotate and then lose the only copy of the new secret.
 *   3. DEFINE USER OVERWRITE root ON ROOT PASSWORD '<new>' ROLES OWNER —
 *      users live in the KV store, so the rotation survives container
 *      restarts (the container's SURREAL_USER/SURREAL_PASS env only seeds a
 *      root user when NONE exists yet).
 *   4. Verify: the OLD default credential must now FAIL; the new admin
 *      credential and the scoped daemon user must still work.
 *
 * The new secret is never printed — receipts reference the file path only.
 * Run AFTER provision-scoped-users.mjs and after the daemon has been
 * switched to its scoped user, so nothing still depends on the old default.
 */
import { Surreal } from "surrealdb";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const URL = process.env.SURREAL_URL || "ws://localhost:8000/rpc";
const OLD_USER = process.env.SURREAL_ADMIN_USER || "root";
const OLD_PASS = process.env.SURREAL_ADMIN_PASS || "root";
const ADMIN_CRED_PATH = homedir() + "/.laqrumcode/surreal-admin-cred.json";

const newPass = randomBytes(24).toString("base64url");

// 1+2: persist first (see ordering rationale above).
const record = {
  user: "root",
  pass: newPass,
  url: URL,
  rotated_at: new Date().toISOString(),
  note: "SurrealDB root (OWNER) credential — rotated off the legacy default by scripts/rotate-root-cred.mjs. The daemon does NOT use this; it authenticates as the scoped EDITOR user in surreal-cred.json. Keep 0600.",
};
writeFileSync(ADMIN_CRED_PATH, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
try { chmodSync(ADMIN_CRED_PATH, 0o600); } catch { /* best-effort */ }
console.log(`new admin secret persisted to ${ADMIN_CRED_PATH} (0600)`);

// 3: rotate.
const admin = new Surreal();
await admin.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: OLD_USER, password: OLD_PASS } });
try {
  await admin.query(`DEFINE USER OVERWRITE root ON ROOT PASSWORD '${newPass}' ROLES OWNER`);
  console.log("root credential rotated (DEFINE USER OVERWRITE root ON ROOT ... ROLES OWNER)");
} finally { await admin.close(); }

// 4a: the old default must now fail.
const old = new Surreal();
let oldWorks = false;
try {
  await old.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: "root", password: "root" } });
  await old.query("RETURN 1");
  oldWorks = true;
} catch { /* expected */ }
finally { try { await old.close(); } catch { /* ignore */ } }
if (oldWorks) {
  console.error("VERIFY FAILED: the old root/root default STILL authenticates — rotation did not take effect");
  process.exit(2);
}
console.log("verify: old root/root default now REJECTED");

// 4b: the new admin credential works.
const fresh = new Surreal();
await fresh.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: "root", password: newPass } });
try {
  await fresh.query("RETURN 1");
  console.log("verify: new admin credential signs in (OWNER)");
} finally { await fresh.close(); }

// 4c: the scoped daemon user is unaffected.
const credPath = homedir() + "/.laqrumcode/surreal-cred.json";
if (existsSync(credPath)) {
  const c = JSON.parse(readFileSync(credPath, "utf8"));
  const u = new Surreal();
  await u.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: c.user, password: c.pass } });
  try {
    await u.query("RETURN 1");
    console.log(`verify: scoped daemon user '${c.user}' unaffected`);
  } finally { await u.close(); }
}
console.log("rotation complete");
