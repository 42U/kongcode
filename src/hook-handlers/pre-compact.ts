/**
 * PreCompact hook handler.
 *
 * Fires BEFORE Claude Code shrinks the conversation window.
 * Ingests any pending turns into SurrealDB before they're lost.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { ingestTurn } from "../context-assembler.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

export async function handlePreCompact(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  log.info(`PreCompact: flushing knowledge before compaction for session ${sessionId}`);

  // Ingest any un-ingested turns while we still have the full conversation
  if (session.lastUserText) {
    await ingestTurn(state, session, "user", session.lastUserText).catch(() => {});
  }
  if (session.lastAssistantText) {
    await ingestTurn(state, session, "assistant", session.lastAssistantText).catch(() => {});
  }

  // Flush session stats to DB
  const { store } = state;
  if (store.isAvailable() && session.surrealSessionId) {
    try {
      await store.updateSessionStats(
        session.surrealSessionId,
        session._pendingInputTokens,
        session._pendingOutputTokens,
      );
      session._pendingInputTokens = 0;
      session._pendingOutputTokens = 0;
      session._statsFlushCounter = 0;
    } catch (e) {
      swallow("preCompact:sessionStats", e);
    }
  }

  // Stash compaction summary for PostCompact to use
  const parts: string[] = [];
  parts.push(`Session: turn ${session.userTurnCount}, ${session.cumulativeTokens} tokens processed`);
  if (session.lastUserText) parts.push(`Last user request: ${session.lastUserText.slice(0, 200)}`);
  if (session.currentConfig) parts.push(`Current intent: ${session.currentConfig.intent ?? "unknown"}`);
  session._compactionSummary = parts.join("\n");

  return {};
}
