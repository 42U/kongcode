/**
 * MCP wrapper for the introspect tool.
 * Bridges the engine's createIntrospectToolDef to MCP CallToolResult format.
 */
import { createIntrospectToolDef } from "../engine/tools/introspect.js";
export async function handleIntrospect(state, session, args) {
    const toolDef = createIntrospectToolDef(state, session);
    const result = await toolDef.execute("mcp-introspect", {
        action: String(args.action ?? "status"),
        table: args.table,
        filter: args.filter,
        record_id: args.record_id,
    });
    return { content: result.content };
}
