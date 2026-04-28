/**
 * supersede MCP tool — explicit stale-knowledge correction.
 *
 * Lets users/bots say "this thing we believed is no longer true — here is
 * the new version." The substrate:
 *   1. Embeds the old text, finds the top-N concepts whose embedding
 *      matches (via linkSupersedesEdges threshold)
 *   2. Writes a new memory node with the correction text (category
 *      "correction", importance 9)
 *   3. Creates supersedes edges: correction_memory → stale_concept
 *   4. Decays the stability of each superseded concept so it loses
 *      priority in recall
 *
 * This is the explicit, structured alternative to letting the daemon
 * detect corrections from transcript text — useful when the bot KNOWS
 * a belief is stale and wants to mark it definitively rather than hope
 * the extractor catches it.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleSupersede(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
