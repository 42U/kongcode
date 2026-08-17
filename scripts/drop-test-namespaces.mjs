#!/usr/bin/env node
/**
 * Drop ONLY the ephemeral vitest temp namespaces + the old-brand test ns from
 * the target SurrealDB instance. Targets: kctest_* and kong_test.
 * NEVER touches kong / laqrum / laqrum_test / main.
 *
 * LAQ-SEC-007 rewrite of the old drop-test-namespaces.sh, which used
 * `curl -u root:root` — a credential the hardening rotated away, passed via
 * argv (world-readable through /proc while curl runs). Namespace removal
 * needs OWNER, so credentials resolve as:
 *   1. SURREAL_ADMIN_USER + SURREAL_ADMIN_PASS env
 *   2. ~/.laqrumcode/surreal-admin-cred.json (written by rotate-root-cred.mjs)
 * There is no root:root fallback — a hardened instance rejects it and an
 * unhardened one should be hardened first (scripts/rotate-root-cred.mjs).
 */
import { Surreal } from "surrealdb";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const URL = process.env.SURREAL_URL || "ws://localhost:8000/rpc";
const KEEP = new Set(["kong", "laqrum", "laqrum_test", "main"]);
const TARGET_RE = /^(kctest_[A-Za-z0-9_]+|kong_test)$/;

function adminCred() {
  if (process.env.SURREAL_ADMIN_USER && process.env.SURREAL_ADMIN_PASS) {
    return { user: process.env.SURREAL_ADMIN_USER, pass: process.env.SURREAL_ADMIN_PASS };
  }
  const path = homedir() + "/.laqrumcode/surreal-admin-cred.json";
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (c?.user && c?.pass) return { user: c.user, pass: c.pass };
  } catch { /* fall through to the error below */ }
  console.error("No admin credential: set SURREAL_ADMIN_USER/PASS or run scripts/rotate-root-cred.mjs first (writes ~/.laqrumcode/surreal-admin-cred.json).");
  process.exit(1);
}

const cred = adminCred();
const db = new Surreal();
await db.connect(URL, { namespace: "laqrum", database: "memory", authentication: { username: cred.user, password: cred.pass } });
try {
  const info = await db.query("INFO FOR ROOT");
  const all = Object.keys(info[0]?.namespaces ?? {});
  const targets = all.filter((ns) => TARGET_RE.test(ns) && !KEEP.has(ns));
  if (targets.length === 0) {
    console.log("No test namespaces to drop. Namespaces present:", all.join(", "));
  } else {
    console.log(`Dropping ${targets.length} test namespace(s) (keeping ${[...KEEP].join(" / ")}):`);
    for (const ns of targets) {
      // Namespace names are regex-validated above ([A-Za-z0-9_] only) — safe
      // to interpolate into the DDL statement (bindings are not supported in
      // REMOVE NAMESPACE).
      process.stdout.write(`  dropping ${ns} ... `);
      await db.query(`REMOVE NAMESPACE IF EXISTS ${ns}`);
      console.log("ok");
    }
  }
  const after = await db.query("INFO FOR ROOT");
  console.log("Remaining namespaces:", Object.keys(after[0]?.namespaces ?? {}).join(", "));
} finally { await db.close(); }
