/**
 * MCP wrapper for the recall tool.
 * Bridges the engine's createRecallToolDef to MCP CallToolResult format.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { createRecallToolDef } from "../engine/tools/recall.js";

export async function handleRecall(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const toolDef = createRecallToolDef(state, session);
  const result = await toolDef.execute("mcp-recall", {
    query: String(args.query ?? ""),
    scope: args.scope as string | undefined,
    limit: args.limit as number | undefined,
  });
  return { content: result.content };
}
