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
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleLinkHierarchy(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
