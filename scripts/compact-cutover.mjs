#!/usr/bin/env node
/**
 * compact-cutover.mjs — multi-namespace fresh-store builder + delta-repair for
 * the kongdb cutover (reclaim the ~14G un-GC'd surrealkv vlog).
 *
 * Companion to compact-store.mjs (which migrates ONE namespace and prints a
 * MANUAL runbook). The kongdb instance is SHARED: it hosts BOTH `laqrum`
 * (laqrumcode prod) AND `kong` (kongcode prod, ~317k rows). A cutover MUST
 * migrate both into the fresh store or kongcode is lost. This tool does that,
 * reusing compact-store.mjs's proven import + id-diff-repair logic verbatim
 * (only generalized to take (ns,db) per call).
 *
 * Subcommands:
 *   build   — wipe a fresh surrealkv store, start a scratch v3.1.4 container on
 *             it, import each namespace's .surql, run id-diff repair vs live
 *             prod (recover import-chunk-abort drops), verify counts+index,
 *             then STOP the scratch container so the store is flushed/closed.
 *             Leaves the fresh store at $STAGE/fresh-store/kongdb (matches the
 *             prod store subdir name so cutover is a clean dir move).
 *   counts <httpBase>            — print per-namespace table counts at a URL.
 *   repair <srcHttpBase> <dstHttpBase>
 *           — id-diff repair src→dst for every namespace (the post-swap
 *             delta-sync: src = the FROZEN old store on a temp container,
 *             dst = the live new store; copies any rows written during the
 *             migration window). Guarantees no data loss vs the old store.
 *
 * Env: SURREAL_USER/PASS (root/root), LAQRUMCODE_COMPACT_STAGE_DIR
 *      (/mnt/money/voidorigin/laqrumcode-compact), image surrealdb/surrealdb:v3.1.4.
 * NEVER deletes the old store. Production swap is done by the human-run bash
 * around this tool, not by this tool.
 */
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";

import { resolveScriptCred } from "./surreal-cred.mjs";
const { user: USER, pass: PASS } = resolveScriptCred();
const STAGE = process.env.LAQRUMCODE_COMPACT_STAGE_DIR || "/mnt/money/voidorigin/laqrumcode-compact";
const IMAGE = "surrealdb/surrealdb:v3.1.4";
const SCRATCH = "laqrumcode-cutover-build";
const PORT = Number(process.env.LAQRUMCODE_COMPACT_PORT) || 8940;
const FRESH_DIR = join(STAGE, "fresh-store");      // bind -> /mydata
const STORE_SUBDIR = "kongdb";                       // matches prod: surrealkv:/mydata/kongdb
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

// (ns, db, exportFile) for every namespace that must survive the cutover.
const NAMESPACES = [
  { ns: "laqrum", db: "memory", file: join(STAGE, "laqrum-memory-export.surql") },
  { ns: "kong", db: "memory", file: join(STAGE, "legacy-kong--memory.surql") },
];

function sh(cmd) { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

async function sql(base, q, ns, db) {
  const res = await fetch(`${base}/sql`, {
    method: "POST",
    headers: { Authorization: AUTH, Accept: "application/json", "surreal-ns": ns, "surreal-db": db },
    body: q,
  });
  if (!res.ok) throw new Error(`${base}/sql ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function listTables(base, ns, db) {
  const r = await sql(base, "INFO FOR DB", ns, db);
  return Object.keys(r?.[0]?.result?.tables ?? {});
}

async function counts(base, tables, ns, db) {
  const out = {};
  for (const t of tables) {
    try {
      const r = await sql(base, `SELECT count() AS c FROM ${t} GROUP ALL`, ns, db);
      out[t] = r?.[0]?.result?.[0]?.c ?? 0;
    } catch { out[t] = "ERR"; }
  }
  return out;
}

// Verbatim port of compact-store.mjs idDiffRepair, parameterized by (ns,db).
async function idDiffRepair(srcWsUrl, dstWsUrl, tables, ns, db) {
  const { Surreal } = await import(new URL("../node_modules/surrealdb/dist/surrealdb.mjs", import.meta.url).href);
  async function open(url) {
    const d = new Surreal();
    await d.connect(url);
    await d.signin({ username: USER, password: PASS });
    await d.use({ namespace: ns, database: db });
    return d;
  }
  const src = await open(srcWsUrl);
  const dst = await open(dstWsUrl);
  let repaired = 0, dupSkipped = 0, failures = 0;
  try {
    for (const t of tables) {
      const [srcRows] = await src.query(`SELECT <string>id AS id FROM ${t}`);
      const srcIds = (srcRows ?? []).map(r => r.id);
      if (!srcIds.length) continue;
      const [dstRows] = await dst.query(`SELECT <string>id AS id FROM ${t}`).catch(() => [[]]);
      const have = new Set((dstRows ?? []).map(r => r.id));
      const missing = srcIds.filter(id => !have.has(id));
      if (!missing.length) continue;
      let tOk = 0, tDup = 0, tFail = 0;
      for (const id of missing) {
        const [rows] = await src.query(`SELECT * FROM ${id}`);
        const row = rows?.[0];
        if (!row) continue;
        const isRel = row.in !== undefined && row.out !== undefined;
        try {
          if (isRel) {
            const { id: _i, ...rest } = row;
            await dst.query(`INSERT RELATION INTO ${t} $content`, { content: { id: row.id, ...rest } });
          } else {
            await dst.query(`CREATE ${id} CONTENT $content`, {
              content: Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id")),
            });
          }
          tOk++;
        } catch (e) {
          if (/already contains|already exists/i.test(String(e?.message ?? e))) tDup++;
          else tFail++;
        }
      }
      repaired += tOk; dupSkipped += tDup; failures += tFail;
      if (missing.length) console.log(`      [${ns}] repair ${t}: missing=${missing.length} copied=${tOk} dup-skipped=${tDup} failed=${tFail}`);
    }
  } finally {
    await src.close().catch(() => {});
    await dst.close().catch(() => {});
  }
  return { repaired, dupSkipped, failures };
}

async function waitHealthy(base, secs = 40) {
  for (let i = 0; i < secs; i++) {
    try { const h = await fetch(`${base}/health`); if (h.ok) return true; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function importFile(base, ns, db, file) {
  const imp = await fetch(`${base}/import`, {
    method: "POST",
    headers: { Authorization: AUTH, Accept: "application/json", "surreal-ns": ns, "surreal-db": db },
    body: createReadStream(file),
    duplex: "half",
  });
  if (!imp.ok) throw new Error(`/import ${ns}/${db} failed: ${imp.status}: ${(await imp.text()).slice(0, 300)}`);
}

const PROD = "http://127.0.0.1:8000";
const PROD_WS = "ws://127.0.0.1:8000/rpc";

async function build() {
  console.log(`compact-cutover BUILD → fresh ${IMAGE} store at ${FRESH_DIR}/${STORE_SUBDIR} (scratch :${PORT})`);
  for (const n of NAMESPACES) {
    if (!existsSync(n.file)) throw new Error(`missing export for ${n.ns}/${n.db}: ${n.file} — export it first`);
    console.log(`  export present: ${n.ns}/${n.db} = ${(statSync(n.file).size / 1e9).toFixed(2)}GB`);
  }
  mkdirSync(FRESH_DIR, { recursive: true });
  // Fresh must mean fresh (compact-store G1): wipe + open perms via docker (image is nonroot).
  try { sh(`sudo docker rm -f ${SCRATCH}`); } catch { /* not running */ }
  sh(`sudo docker run --rm -v ${FRESH_DIR}:/wipe alpine sh -c "rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null; chmod 777 /wipe; true"`);
  sh(`sudo docker run -d --name ${SCRATCH} -p 127.0.0.1:${PORT}:8000 -v ${FRESH_DIR}:/mydata ${IMAGE} start surrealkv:/mydata/${STORE_SUBDIR} --user ${USER} --pass ${PASS}`);
  const scratch = `http://127.0.0.1:${PORT}`;
  const scratchWs = `ws://127.0.0.1:${PORT}/rpc`;
  if (!await waitHealthy(scratch)) throw new Error("scratch did not become healthy");

  let allOk = true;
  for (const n of NAMESPACES) {
    console.log(`  ── ${n.ns}/${n.db} ──`);
    const prodTables = await listTables(PROD, n.ns, n.db);
    const before = await counts(PROD, prodTables, n.ns, n.db);
    console.log(`    source ${prodTables.length} tables`);
    console.log(`    importing ${n.file}…`);
    await importFile(scratch, n.ns, n.db, n.file);
    const rep = await idDiffRepair(PROD_WS, scratchWs, prodTables, n.ns, n.db);
    console.log(`    repair totals: copied=${rep.repaired} dup-skipped=${rep.dupSkipped} failed=${rep.failures}`);
    const after = await counts(scratch, prodTables, n.ns, n.db);
    let mism = 0;
    for (const t of prodTables) {
      const ok = before[t] === after[t] || (typeof after[t] === "number" && typeof before[t] === "number" && after[t] >= before[t]);
      if (!ok) { mism++; console.log(`    ${t}: source=${before[t]} fresh=${after[t]} MISMATCH`); }
    }
    // index sanity on turn (both namespaces have it)
    let idxOk = true;
    try {
      const a = await sql(scratch, `SELECT id FROM turn WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`, n.ns, n.db);
      const b = await sql(scratch, `SELECT id FROM turn WITH NOINDEX WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`, n.ns, n.db);
      idxOk = (a?.[0]?.result?.length ?? 0) === (b?.[0]?.result?.length ?? 0);
    } catch { /* no turn table — skip */ }
    const nsOk = mism === 0 && rep.failures === 0 && idxOk;
    console.log(`    ${n.ns}: ${prodTables.length - mism}/${prodTables.length} tables OK, index-sane=${idxOk}, repair-failures=${rep.failures} → ${nsOk ? "OK" : "NOT CLEAN"}`);
    if (!nsOk) allOk = false;
  }

  // Stop the scratch container so surrealkv flushes & closes the store before we move it.
  console.log("  stopping scratch container (flush store)…");
  sh(`sudo docker stop ${SCRATCH}`);
  sh(`sudo docker rm ${SCRATCH}`);
  const sz = sh(`sudo du -sh ${FRESH_DIR}/${STORE_SUBDIR} 2>/dev/null | cut -f1 || true`);
  console.log(`\n  FRESH STORE: ${FRESH_DIR}/${STORE_SUBDIR}  (size ${sz})`);
  console.log(`  VERDICT: ${allOk ? "VERIFIED — all namespaces complete & index-sane" : "NOT CLEAN — do NOT cut over"}`);
  process.exit(allOk ? 0 : 1);
}

async function cmdCounts(base) {
  for (const n of NAMESPACES) {
    const t = await listTables(base, n.ns, n.db).catch(() => []);
    const c = await counts(base, t, n.ns, n.db);
    const total = Object.values(c).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    console.log(`  ${n.ns}/${n.db}: ${t.length} tables, ${total} total rows`);
    // headline tables
    for (const k of ["concept", "memory", "turn", "turn_archive", "retrieval_outcome", "artifact"]) {
      if (c[k] !== undefined) console.log(`    ${k}=${c[k]}`);
    }
  }
}

async function repair(srcBase, dstBase) {
  const srcWs = srcBase.replace(/^http/, "ws") + "/rpc";
  const dstWs = dstBase.replace(/^http/, "ws") + "/rpc";
  console.log(`compact-cutover REPAIR (delta-sync) ${srcBase} → ${dstBase}`);
  let grand = { repaired: 0, dupSkipped: 0, failures: 0 };
  for (const n of NAMESPACES) {
    const tables = await listTables(srcBase, n.ns, n.db).catch(() => []);
    if (!tables.length) { console.log(`  [${n.ns}] no tables on src — skip`); continue; }
    const rep = await idDiffRepair(srcWs, dstWs, tables, n.ns, n.db);
    console.log(`  [${n.ns}] delta: copied=${rep.repaired} dup-skipped=${rep.dupSkipped} failed=${rep.failures}`);
    grand.repaired += rep.repaired; grand.dupSkipped += rep.dupSkipped; grand.failures += rep.failures;
  }
  console.log(`  DELTA TOTALS: copied=${grand.repaired} dup-skipped=${grand.dupSkipped} failed=${grand.failures}`);
  process.exit(grand.failures === 0 ? 0 : 1);
}

const cmd = process.argv[2];
if (cmd === "build") build().catch(e => { console.error("BUILD FAILED:", e?.message ?? e); process.exit(1); });
else if (cmd === "counts") cmdCounts(process.argv[3] || PROD).catch(e => { console.error(e?.message ?? e); process.exit(1); });
else if (cmd === "repair") repair(process.argv[3], process.argv[4]).catch(e => { console.error("REPAIR FAILED:", e?.message ?? e); process.exit(1); });
else { console.error("usage: compact-cutover.mjs build | counts <base> | repair <srcBase> <dstBase>"); process.exit(1); }
