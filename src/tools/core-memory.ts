/**
 * MCP wrapper for the core_memory tool.
 * Bridges the engine's createCoreMemoryToolDef to MCP CallToolResult format.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { createCoreMemoryToolDef } from "../engine/tools/core-memory.js";

export async function handleCoreMemory(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const toolDef = createCoreMemoryToolDef(state, session);
  const result = await toolDef.execute("mcp-core-memory", {
    action: String(args.action ?? "list") as "list" | "add" | "update" | "deactivate",
    tier: args.tier as number | undefined,
    category: args.category as string | undefined,
    text: args.text as string | undefined,
    priority: args.priority as number | undefined,
    id: args.id as string | undefined,
    session_id: args.session_id as string | undefined,
  });
  return { content: result.content };
}
