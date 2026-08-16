/**
 * Shared credential resolution for the standalone scripts (backup / restore /
 * migrate / live-fire). Phase 3 counterpart of the daemon's external-target
 * credential chain in src/engine/bootstrap.ts:
 *
 *   1. SURREAL_USER + SURREAL_PASS env — explicit operator intent, verbatim.
 *      (Half-set env is treated as explicit too, so a typo fails loudly
 *      instead of silently falling back to a different identity.)
 *   2. The managed per-user cred file (~/.laqrumcode/surreal-cred.json) — the
 *      secret the daemon itself uses; present on any machine with a managed
 *      or hardened instance.
 *   3. Legacy root:root default — pre-hardening compatibility only.
 *
 * Scripts previously hardcoded `process.env.SURREAL_USER || "root"`, which
 * broke the moment the instance's root credential was rotated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveScriptCred() {
  const envUser = process.env.SURREAL_USER;
  const envPass = process.env.SURREAL_PASS;
  if (envUser || envPass) {
    return { user: envUser || "root", pass: envPass || "root", source: "env" };
  }
  const credPath = join(homedir(), ".laqrumcode", "surreal-cred.json");
  try {
    const parsed = JSON.parse(readFileSync(credPath, "utf8"));
    if (parsed && typeof parsed.user === "string" && parsed.user && typeof parsed.pass === "string" && parsed.pass) {
      return { user: parsed.user, pass: parsed.pass, source: credPath };
    }
  } catch { /* absent/malformed → legacy default */ }
  return { user: "root", pass: "root", source: "legacy-default" };
}
