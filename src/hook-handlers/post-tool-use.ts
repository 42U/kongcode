/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { swallow } from "../engine/errors.js";
import { commitKnowledge } from "../engine/commit.js";
import { recordToolOutcome } from "../engine/retrieval-quality.js";

export async function handlePostToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const { store, embeddings } = state;
  const toolName = (payload.tool_name as string) ?? "";
  // Claude Code's PostToolUse payload field is `tool_response` (object or
  // string). The previous `tool_result` read was wrong and never matched,
  // so cumulativeTokens was stuck at 0 and recordToolOutcome never fired.
  const toolResponse = payload.tool_response ?? payload.tool_result;
  const toolResultText = typeof toolResponse === "string"
    ? toolResponse
    : toolResponse != null ? JSON.stringify(toolResponse) : undefined;

  if (toolResultText) {
    session.cumulativeTokens += Math.ceil(toolResultText.length / 4);
  }

  // Detect failure: top-level `error`, or tool_response object with
  // is_error=true (Anthropic tool_result convention).
  const isError = !!payload.error
    || (typeof toolResponse === "object" && toolResponse !== null
        && (toolResponse as { is_error?: boolean }).is_error === true);
  recordToolOutcome(!isError);

  // Count tool calls for this turn — consumed by handleStop to feed
  // postflight()'s orchestrator_metrics write. Reset at preflight time.
  session._turnToolCalls += 1;

  // Track file artifacts from Write/Edit tools
  if ((toolName === "Write" || toolName === "Edit") && store.isAvailable()) {
    const toolInput = session.pendingToolArgs.get(toolName) as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (filePath) {
      try {
        // Route through commitKnowledge so the file artifact auto-seals
        // artifact_mentions edges to concepts. Previously this write was
        // a bare createArtifact; the artifact landed without any edges
        // to the concept graph, so "what concepts is this file about?"
        // queries returned nothing.
        await commitKnowledge(
          { store, embeddings },
          {
            kind: "artifact",
            path: filePath,
            type: "file",
            description: `${toolName}: ${filePath}`,
          },
        );
      } catch (e) {
        swallow("postToolUse:artifact", e);
      }
    }
    session.pendingToolArgs.delete(toolName);
  }

  return {};
}
