/**
 * MCP wrapper for the recall tool.
 * Bridges the engine's createRecallToolDef to MCP CallToolResult format.
 */
import { createRecallToolDef } from "../engine/tools/recall.js";
export async function handleRecall(state, session, args) {
    const toolDef = createRecallToolDef(state, session);
    const result = await toolDef.execute("mcp-recall", {
        query: String(args.query ?? ""),
        scope: args.scope,
        limit: args.limit,
    });
    return { content: result.content };
}
