#!/usr/bin/env node
/**
 * Concept merge pass: find near-duplicate concepts via embedding similarity
 * and merge them. The canonical keeper is whichever concept has the higher
 * access_count (ties → older record). All graph edges are re-pointed to the
 * canonical, then the duplicate is deleted.
 *
 * Usage:
 *   cd /mnt/c/Users/charl/kongcode
 *   node scripts/merge-duplicate-concepts.mjs           # dry-run, report only
 *   node scripts/merge-duplicate-concepts.mjs --apply   # actually merge
 */
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";

const APPLY = process.argv.includes("--apply");
const THRESHOLD = 0.95; // cosine similarity cutoff for "duplicate"
// Short one-word concepts ("api", "config", "UTC") have noisy, context-free
// embeddings that cluster with each other. Only merge concepts that have a
// real amount of content — that's where duplication actually matters.
const MIN_CONTENT_LEN = 30;

// Edge tables that reference concept records. If you add new edges in
// schema.surql, add them here so this script re-points them too.
const EDGE_TABLES = [
  "mentions",
  "about_concept",
  "artifact_mentions",
  "derived_from",
  "narrower",
  "broader",
  "related_to",
];

async function main() {
  const config = parsePluginConfig({});
  const store = new SurrealStore(config.surreal);
  await store.initialize();
  console.log(`[merge] APPLY=${APPLY}  threshold=${THRESHOLD}`);

  const concepts = await store.queryFirst(
    `SELECT id, content, access_count, embedding
     FROM concept
     WHERE embedding != NONE AND array::len(embedding) > 0
       AND string::len(content) >= $minlen;`,
    { minlen: MIN_CONTENT_LEN },
  );
  console.log(`[merge] concepts with embeddings + len>=${MIN_CONTENT_LEN}: ${concepts.length}`);

  // Group concepts into clusters of near-duplicates. Greedy: iterate, assign
  // each concept to an existing cluster if it passes the threshold against
  // any member, else start a new cluster.
  const seen = new Set();
  const merges = []; // { canonical, duplicates: [] }
  for (const c of concepts) {
    const cid = String(c.id);
    if (seen.has(cid)) continue;
    const similar = await store.queryFirst(
      `SELECT id, content, access_count,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE id != $cid
         AND embedding != NONE AND array::len(embedding) > 0
         AND string::len(content) >= $minlen
         AND vector::similarity::cosine(embedding, $vec) >= $thr
       ORDER BY score DESC`,
      { vec: c.embedding, cid: c.id, thr: THRESHOLD, minlen: MIN_CONTENT_LEN },
    );
    if (similar.length === 0) continue;

    // Cluster: c + similar (filter out already-merged ones)
    const cluster = [c, ...similar.filter(s => !seen.has(String(s.id)))];
    if (cluster.length < 2) continue;

    // Canonical: highest access_count, then shortest content (more generic wins)
    cluster.sort((a, b) => {
      const ac = Number(b.access_count ?? 0) - Number(a.access_count ?? 0);
      if (ac !== 0) return ac;
      return String(a.content || "").length - String(b.content || "").length;
    });
    const canonical = cluster[0];
    const duplicates = cluster.slice(1);

    seen.add(String(canonical.id));
    for (const d of duplicates) seen.add(String(d.id));

    merges.push({ canonical, duplicates });
  }

  console.log(`[merge] clusters found: ${merges.length}`);
  let mergedConcepts = 0;
  let repointedEdges = 0;

  for (const { canonical, duplicates } of merges) {
    console.log(
      `\n[merge] canonical=${canonical.id} (access=${canonical.access_count ?? 0})`,
    );
    console.log(`  content: ${String(canonical.content).slice(0, 100)}`);
    for (const dup of duplicates) {
      console.log(
        `  - dup=${dup.id} (access=${dup.access_count ?? 0}) score=${Number(dup.score ?? 0).toFixed(3)}`,
      );
      console.log(`    content: ${String(dup.content).slice(0, 100)}`);
      if (!APPLY) continue;

      const totalAccess =
        Number(canonical.access_count ?? 0) + Number(dup.access_count ?? 0);

      // Re-point every edge that references the duplicate
      for (const tbl of EDGE_TABLES) {
        try {
          const inRes = await store.queryExec(
            `UPDATE ${tbl} SET in = $can WHERE in = $dup;`,
            { can: canonical.id, dup: dup.id },
          );
          const outRes = await store.queryExec(
            `UPDATE ${tbl} SET out = $can WHERE out = $dup;`,
            { can: canonical.id, dup: dup.id },
          );
          repointedEdges += (inRes?.length ?? 0) + (outRes?.length ?? 0);
        } catch (e) {
          console.warn(`    [edge-skip] ${tbl}: ${e.message}`);
        }
      }

      // Sum access_count on canonical, delete dup
      try {
        await store.queryExec(
          `UPDATE ${canonical.id} SET access_count = $n, last_accessed = time::now();`,
          { n: totalAccess },
        );
        await store.queryExec(`DELETE ${dup.id};`);
        canonical.access_count = totalAccess; // keep local view consistent
        mergedConcepts++;
      } catch (e) {
        console.warn(`    [merge-fail] ${dup.id}: ${e.message}`);
      }
    }
  }

  const finalC = await store.queryFirst("SELECT count() AS n FROM concept GROUP ALL;");
  console.log("\n=== SUMMARY ===");
  console.log(`clusters: ${merges.length}`);
  console.log(`concepts merged: ${mergedConcepts}${APPLY ? "" : " (dry-run)"}`);
  console.log(`edges re-pointed: ${repointedEdges}`);
  console.log(`final concept count: ${Number(finalC?.[0]?.n ?? 0)}`);
  await store.shutdown?.();
  process.exit(0);
}

main().catch((e) => {
  console.error("[merge] FATAL:", e);
  process.exit(1);
});
