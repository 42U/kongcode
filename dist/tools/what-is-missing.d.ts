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
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleWhatIsMissing(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
