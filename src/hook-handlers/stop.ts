/**
 * Stop hook handler.
 *
 * Turn boundary marker: ingests the assistant response, updates token
 * counters, and evaluates retrieval quality.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { ingestTurn } from "../context-assembler.js";
import { evaluateRetrieval } from "../engine/retrieval-quality.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

export async function handleStop(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const { store } = state;

  // Ingest assistant response if we have it
  if (session.lastAssistantText) {
    ingestTurn(state, session, "assistant", session.lastAssistantText).catch(() => {});
  }

  // Evaluate retrieval quality for ACAN training
  if (store.isAvailable() && session.lastAssistantTurnId) {
    try {
      await evaluateRetrieval(
        session.lastAssistantTurnId,
        session.lastAssistantText,
        store,
      );
    } catch (e) {
      swallow("stop:retrievalQuality", e);
    }
  }

  log.debug(`Stop: turn=${session.userTurnCount}, tokens=${session.cumulativeTokens}`);

  return {};
}
