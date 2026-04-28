/**
 * what_is_missing MCP tool — proactive gap detection.
 *
 * Plain recall is reactive: "what is similar to X?". what_is_missing is
 * prospective: "given X, what ELSE in the graph might be relevant that
 * pure similarity wouldn't surface?"
 *
 * Algorithm:
 *   1. Vector-search the context for a seed set of concepts (top-N)
 *   2. Traverse narrower/broader/related_to edges from that seed
 *   3. Concepts reachable via the graph but NOT in the similarity top-N
 *      are the "gaps" — semantically adjacent content that plain recall
 *      wouldn't have pulled.
 *
 * The turn from reactive memory tool → brain is exactly this: a brain
 * volunteers "what you might be forgetting," a memory tool waits to be
 * asked.
 */
import { swallow } from "../engine/errors.js";
async function seedConceptsFromContext(state, context, limit) {
    if (!state.embeddings.isAvailable())
        return [];
    try {
        const vec = await state.embeddings.embed(context);
        if (!vec?.length)
            return [];
        const rows = await state.store.queryFirst(`SELECT id, content, vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC
       LIMIT $lim`, { vec, lim: limit });
        return rows.filter(r => r.score >= 0.55).map(r => ({
            id: String(r.id),
            content: String(r.content),
            score: Number(r.score),
        }));
    }
    catch (e) {
        swallow("whatIsMissing:seed", e);
        return [];
    }
}
async function collectGraphNeighbors(state, seedIds) {
    if (seedIds.length === 0)
        return [];
    const collected = new Map();
    // For each seed concept, pull outgoing broader/narrower/related_to edges.
    // Union the results; de-dup by id.
    for (const sid of seedIds) {
        try {
            const rows = await state.store.queryFirst(`SELECT id, content FROM (
           SELECT ->broader->concept AS hits FROM ${sid}
           UNION
           SELECT ->narrower->concept AS hits FROM ${sid}
           UNION
           SELECT ->related_to->concept AS hits FROM ${sid}
         )`).catch(() => []);
            for (const r of rows) {
                const id = r.id ?? r.hits;
                if (!id)
                    continue;
                const content = r.content;
                const idStr = String(id);
                if (!collected.has(idStr)) {
                    collected.set(idStr, { id: idStr, content: String(content ?? "") });
                }
            }
        }
        catch (e) {
            swallow("whatIsMissing:traverse", e);
        }
    }
    return [...collected.values()];
}
export async function handleWhatIsMissing(state, _session, args) {
    const context = String(args.context ?? "").trim();
    const seedLimit = Math.min(10, Math.max(3, Number(args.seed_limit) || 6));
    const gapLimit = Math.min(20, Math.max(5, Number(args.gap_limit) || 10));
    if (!context || context.length < 10) {
        return {
            content: [{
                    type: "text",
                    text: "Error: `context` is required and should be at least 10 characters describing the current focus.",
                }],
        };
    }
    if (!state.store.isAvailable()) {
        return { content: [{ type: "text", text: "Error: store unavailable." }] };
    }
    // 1. Seed concepts from the context (what similarity would surface).
    const seeds = await seedConceptsFromContext(state, context, seedLimit);
    if (seeds.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        ok: true,
                        context: context.slice(0, 100),
                        seeds_found: 0,
                        gaps: [],
                        note: "No concepts above similarity threshold matched the context. Graph may be sparse on this topic; consider recording a finding first.",
                    }, null, 2),
                }],
        };
    }
    const seedIds = new Set(seeds.map(s => s.id));
    // 2. Collect graph-neighbor concepts — what's reachable via hierarchy /
    //    related_to from the seed set.
    const neighbors = await collectGraphNeighbors(state, [...seedIds]);
    // 3. Gaps = neighbors NOT already in the seed set.
    const gaps = neighbors
        .filter(n => !seedIds.has(n.id) && n.content)
        .slice(0, gapLimit);
    // 4. Compose suggested recall queries so the caller can pull full content.
    const suggestedRecalls = gaps.slice(0, 5).map(g => g.content.slice(0, 80));
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: true,
                    context_preview: context.slice(0, 100),
                    seeds_found: seeds.length,
                    gaps_found: gaps.length,
                    seeds: seeds.map(s => ({ id: s.id, preview: s.content.slice(0, 80), score: Number((s.score ?? 0).toFixed(3)) })),
                    gaps: gaps.map(g => ({ id: g.id, preview: g.content.slice(0, 120) })),
                    suggested_recalls: suggestedRecalls,
                }, null, 2),
            }],
    };
}
