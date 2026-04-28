/**
 * MCP wrapper for the core_memory tool.
 * Bridges the engine's createCoreMemoryToolDef to MCP CallToolResult format.
 */
import { createCoreMemoryToolDef } from "../engine/tools/core-memory.js";
export async function handleCoreMemory(state, session, args) {
    const toolDef = createCoreMemoryToolDef(state, session);
    const result = await toolDef.execute("mcp-core-memory", {
        action: String(args.action ?? "list"),
        tier: args.tier,
        category: args.category,
        text: args.text,
        priority: args.priority,
        id: args.id,
        session_id: args.session_id,
    });
    return { content: result.content };
}
