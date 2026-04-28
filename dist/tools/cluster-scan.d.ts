/**
 * cluster_scan MCP tool — recall with grouped output.
 *
 * Plain recall returns a flat score-sorted list. For questions like "what do
 * I know about X?", a cluster view is more useful than a ranked list:
 *   - Groups results by their shared concept neighbors (if any)
 *   - Labels each cluster by the concepts all members reference
 *   - Surfaces singleton results separately
 *
 * The substrate shape (turns → mentions → concepts ← about_concept ← memories)
 * already makes clustering cheap: two result nodes share a cluster if they
 * overlap significantly on the concept neighbors the graph returned.
 *
 * Wraps the existing vectorSearch primitive; does no new retrieval, just
 * re-shapes the output.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleClusterScan(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
