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
    // Ensure both concepts exist and auto-seal their own edges.
    const [{ id: parentId }, { id: childId }] = await Promise.all([
        commitKnowledge({ store, embeddings }, { kind: "concept", name: parent, source }),
        commitKnowledge({ store, embeddings }, { kind: "concept", name: child, source }),
    ]);
    if (!parentId || !childId) {
        return { content: [{ type: "text", text: "Error: concept upsert failed for one or both terms." }] };
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
                    child_id: childId,
                    edges_written: edgesWritten,
                }, null, 2),
            }],
    };
}
