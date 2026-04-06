/**
 * PreCompact hook handler.
 *
 * Before Claude Code compacts the conversation, extract and preserve
 * critical context: pending work, key files, tool usage, recent errors.
 * Returns as systemMessage so context survives compaction.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { log } from "../engine/log.js";

export async function handlePreCompact(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  // Clear injected sections tracking — after compaction, the model loses
  // previously injected context, so we need to re-inject on next turn
  session.injectedSections.clear();

  // Build compaction summary from session state
  const parts: string[] = [];

  // Session context
  parts.push(`Session: turn ${session.userTurnCount}, ${session.cumulativeTokens} tokens processed`);

  // Last user request
  if (session.lastUserText) {
    parts.push(`Last user request: ${session.lastUserText.slice(0, 200)}`);
  }

  // Retrieval summary
  if (session.lastRetrievalSummary) {
    parts.push(`Last retrieval: ${session.lastRetrievalSummary}`);
  }

  // Adaptive config
  if (session.currentConfig) {
    parts.push(`Current intent: ${session.currentConfig.intent ?? "unknown"}`);
  }

  const summary = parts.join("\n");

  // Stash for next assemble() call
  session._compactionSummary = summary;

  log.debug(`PreCompact: preserving context for session ${sessionId}`);

  return {
    systemMessage: `[KongCode post-compaction context]\n${summary}\n\nNote: Graph memory will re-retrieve relevant context on the next prompt.`,
  };
}
