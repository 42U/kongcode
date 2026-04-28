/**
 * MCP wrapper for the introspect tool.
 * Bridges the engine's createIntrospectToolDef to MCP CallToolResult format.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleIntrospect(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
