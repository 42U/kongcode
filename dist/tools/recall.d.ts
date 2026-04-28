/**
 * MCP wrapper for the recall tool.
 * Bridges the engine's createRecallToolDef to MCP CallToolResult format.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleRecall(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
