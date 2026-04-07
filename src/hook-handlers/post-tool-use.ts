/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { swallow } from "../engine/errors.js";

export async function handlePostToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const { store, embeddings } = state;
  const toolName = (payload.tool_name as string) ?? "";
  const toolResult = payload.tool_result as string | undefined;

  // Estimate tokens from tool result
  if (toolResult) {
    const resultTokens = Math.ceil(toolResult.length / 4);
    session.cumulativeTokens += resultTokens;
  }

  // Track file artifacts from Write/Edit tools
  if ((toolName === "Write" || toolName === "Edit") && store.isAvailable()) {
    const toolInput = session.pendingToolArgs.get(toolName) as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (filePath) {
      try {
        let embedding: number[] | null = null;
        if (embeddings.isAvailable()) {
          embedding = await embeddings.embed(filePath);
        }
        await store.createArtifact(filePath, "file", `${toolName}: ${filePath}`, embedding);
      } catch (e) {
        swallow("postToolUse:artifact", e);
      }
    }
    session.pendingToolArgs.delete(toolName);
  }

  return {};
}
