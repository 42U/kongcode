#!/usr/bin/env node
/**
 * One-shot re-extraction: iterate every preserved turn + salvaged concept + salvaged memory,
 * re-run concept extraction on turn content, and backfill embeddings on existing concepts/memories.
 *
 * Use after a DB salvage/migration where embeddings were lost. Safe to re-run — upsertConcept
 * dedupes by lowercase content and backfills missing embeddings.
 *
 * Usage (from the repo root):
 *   node scripts/rebuild-from-turns.mjs
 */
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";
import { EmbeddingService } from "../dist/engine/embeddings.js";
import { upsertAndLinkConcepts } from "../dist/engine/concept-extract.js";

async function main() {
  const config = parsePluginConfig({});
  console.log("[rebuild] surreal=", config.surreal.url, "ns=", config.surreal.ns, "db=", config.surreal.db);
  console.log("[rebuild] model=", config.embedding.modelPath);

  const store = new SurrealStore(config.surreal);
  await store.initialize();
  console.log("[rebuild] SurrealDB connected.");

  const embeddings = new EmbeddingService(config.embedding);
  await embeddings.initialize();
  console.log("[rebuild] Embedding model loaded.");

  // -------- 1. Backfill embeddings on surviving concepts --------
  const concepts = await store.queryFirst(
    "SELECT id, content FROM concept WHERE embedding IS NONE OR array::len(embedding) = 0;",
  );
  console.log(`[rebuild] ${concepts.length} concepts need embedding backfill.`);
  let cDone = 0;
  for (const c of concepts) {
    try {
      const vec = await embeddings.embed(String(c.content || ""));
      await store.queryExec(`UPDATE ${c.id} SET embedding = $emb;`, { emb: vec });
      cDone++;
      if (cDone % 10 === 0) console.log(`  concepts embedded: ${cDone}/${concepts.length}`);
    } catch (e) {
      console.warn(`  [concept-skip] ${c.id}: ${e.message}`);
    }
  }
  console.log(`[rebuild] Concepts embedded: ${cDone}/${concepts.length}`);

  // -------- 2. Backfill embeddings on surviving memories --------
  // Schema uses `text` for memory body (NOT `content` like concept).
  const memories = await store.queryFirst(
    "SELECT id, text FROM memory WHERE embedding IS NONE OR array::len(embedding) = 0;",
  );
  console.log(`[rebuild] ${memories.length} memories need embedding backfill.`);
  let mDone = 0, mEmpty = 0;
  for (const m of memories) {
    const body = String(m.text || "").trim();
    if (!body) { mEmpty++; continue; }
    try {
      const vec = await embeddings.embed(body);
      if (!vec || vec.length === 0) { mEmpty++; continue; }
      await store.queryExec(`UPDATE ${m.id} SET embedding = $emb;`, { emb: vec });
      mDone++;
    } catch (e) {
      console.warn(`  [memory-skip] ${m.id}: ${e.message}`);
    }
  }
  console.log(`[rebuild] Memories embedded: ${mDone}/${memories.length}  (skipped empty: ${mEmpty})`);

  // -------- 3. Re-extract concepts from ALL turns --------
  // NB: turn records store content in the `text` field (not `content`).
  const turns = await store.queryFirst(
    "SELECT id, text, session_id FROM turn WHERE text IS NOT NONE LIMIT 2000;",
  );
  console.log(`[rebuild] Re-extracting from ${turns.length} turns...`);
  let tDone = 0;
  let newConceptsApprox = 0;
  for (const t of turns) {
    const text = String(t.text || "");
    if (!text || text.length < 40) { tDone++; continue; }
    try {
      // Count concepts before
      const beforeRows = await store.queryFirst("SELECT count() AS n FROM concept GROUP ALL;");
      const before = Number(beforeRows?.[0]?.n ?? 0);
      await upsertAndLinkConcepts(String(t.id), "mentions", text, store, embeddings, "rebuild");
      const afterRows = await store.queryFirst("SELECT count() AS n FROM concept GROUP ALL;");
      const after = Number(afterRows?.[0]?.n ?? 0);
      newConceptsApprox += Math.max(0, after - before);
      tDone++;
      if (tDone % 25 === 0) console.log(`  turns: ${tDone}/${turns.length}  new concepts so far: ~${newConceptsApprox}`);
    } catch (e) {
      console.warn(`  [turn-skip] ${t.id}: ${e.message}`);
    }
  }
  console.log(`[rebuild] Turns processed: ${tDone}/${turns.length}`);
  console.log(`[rebuild] Approx new concepts extracted: ${newConceptsApprox}`);

  // -------- 4. Final counts --------
  const finalC = await store.queryFirst("SELECT count() AS n FROM concept GROUP ALL;");
  const finalM = await store.queryFirst("SELECT count() AS n FROM memory GROUP ALL;");
  const finalMent = await store.queryFirst("SELECT count() AS n FROM mentions GROUP ALL;");
  console.log("\n=== FINAL ===");
  console.log(`concepts: ${Number(finalC?.[0]?.n ?? 0)}`);
  console.log(`memories: ${Number(finalM?.[0]?.n ?? 0)}`);
  console.log(`mentions edges: ${Number(finalMent?.[0]?.n ?? 0)}`);
  await store.shutdown?.();
  process.exit(0);
}

main().catch((e) => {
  console.error("[rebuild] FATAL:", e);
  process.exit(1);
});
