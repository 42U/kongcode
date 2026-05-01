/**
 * link_hierarchy MCP tool — explicit parent→child concept edges.
 *
 * Users/bots can assert "X is a kind of Y" and the substrate writes the
 * broader/narrower edges directly. This is the substrate-does-the-work
 * counterpart to relying entirely on embedding-similarity hierarchy
 * detection in linkConceptHierarchy, which misses hierarchical relations
 * that aren't phrased with substring overlap.
 *
 * Arguments:
 *   parent: concept content (the broader term)
 *   child:  concept content (the narrower term)
 *   source: optional provenance tag for both upserts
 *
 * Both concepts go through commitKnowledge so hierarchy + related_to
 * auto-seal as usual. The explicit broader/narrower edges are written
 * on top — that's the point of the tool, to make the relation explicit
 * where the substrate's pattern-match wouldn't have found it.
 */
import { commitKnowledge } from "../engine/commit.js";
import { swallow } from "../engine/errors.js";
/** Reuse-similarity threshold. 0.7+ means the existing concept is a near
 *  semantic match for the requested name; reuse it rather than creating a
 *  bare-name stub that orphans the original.
 *  0.7.46+: prevents the duplicate-stub bug where create_knowledge_gems
 *  writes a concept with prose content (e.g. "kongcode is a memory
 *  plugin...") and a later link_hierarchy(parent="kongcode") creates a
 *  separate stub concept with content="kongcode" — the two are then
 *  competing duplicates orphaned from the hierarchy. */
const REUSE_THRESHOLD = 0.7;
/** Find an existing concept by embedding similarity to `name`, falling
 *  back to commitKnowledge (which exact-content-matches via upsertConcept,
 *  then creates) if nothing is similar enough. Returns the concept id and
 *  whether it was reused or freshly created. */
async function findOrCreateConcept(store, embeddings, name, source) {
    if (embeddings.isAvailable()) {
        try {
            const vec = await embeddings.embed(name);
            if (vec?.length) {
                const candidates = await store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
           FROM concept
           WHERE embedding != NONE AND array::len(embedding) > 0
             AND superseded_at IS NONE
           ORDER BY score DESC
           LIMIT 1`, { vec });
                if (candidates.length > 0 && (candidates[0].score ?? 0) >= REUSE_THRESHOLD) {
                    return { id: String(candidates[0].id), reused: true };
                }
                // Fall through but pass the precomputed vec to avoid re-embedding.
                const { id } = await commitKnowledge({ store, embeddings }, { kind: "concept", name, source, precomputedVec: vec });
                return { id: id || "", reused: false };
            }
        }
        catch (e) {
            swallow("linkHierarchy:findOrCreate", e);
        }
    }
    const { id } = await commitKnowledge({ store, embeddings }, { kind: "concept", name, source });
    return { id: id || "", reused: false };
}
export async function handleLinkHierarchy(state, _session, args) {
    const parent = String(args.parent ?? "").trim();
    const child = String(args.child ?? "").trim();
    const source = String(args.source ?? "link_hierarchy");
    if (!parent || !child) {
        return { content: [{ type: "text", text: "Error: both `parent` and `child` are required." }] };
    }
    if (parent.toLowerCase() === child.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: parent and child must differ." }] };
    }
    const { store, embeddings } = state;
    // Resolve both concepts: prefer reusing high-similarity existing rows over
    // upserting bare-name stubs that orphan the originals.
    const [parentRes, childRes] = await Promise.all([
        findOrCreateConcept(store, embeddings, parent, source),
        findOrCreateConcept(store, embeddings, child, source),
    ]);
    const parentId = parentRes.id;
    const childId = childRes.id;
    if (!parentId || !childId) {
        return { content: [{ type: "text", text: "Error: concept upsert failed for one or both terms." }] };
    }
    if (parentId === childId) {
        return { content: [{ type: "text", text: "Error: parent and child resolved to the same concept (similarity match collapse). Pick more distinctive names." }] };
    }
    // Explicit hierarchy edges. broader goes parent→child; narrower goes child→parent.
    // Same direction convention linkConceptHierarchy uses internally.
    let edgesWritten = 0;
    try {
        await store.relate(parentId, "broader", childId);
        edgesWritten++;
    }
    catch (e) {
        swallow("linkHierarchy:broader", e);
    }
    try {
        await store.relate(childId, "narrower", parentId);
        edgesWritten++;
    }
    catch (e) {
        swallow("linkHierarchy:narrower", e);
    }
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: edgesWritten > 0,
                    parent_id: parentId,
                    parent_reused: parentRes.reused,
                    child_id: childId,
                    child_reused: childRes.reused,
                    edges_written: edgesWritten,
                }, null, 2),
            }],
    };
}
