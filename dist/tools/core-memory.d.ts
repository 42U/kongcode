/**
 * MCP wrapper for the core_memory tool.
 * Bridges the engine's createCoreMemoryToolDef to MCP CallToolResult format.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleCoreMemory(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
