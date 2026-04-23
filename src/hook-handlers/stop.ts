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
import { postflight } from "../engine/orchestrator.js";
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

  // Postflight: write the per-turn orchestrator_metrics row. The writer
  // in orchestrator.ts had been intact since the port but with zero
  // callers — the preflight side stashed fields on session at context
  // assembly time so we could reach them here across the hook boundary.
  // Table had 0 rows pre-0.4.0 entirely because of this missing call.
  if (store.isAvailable() && session._pendingPreflight) {
    const pending = session._pendingPreflight;
    const tokensIn = session._pendingInputTokens - session._turnTokensInStart;
    const tokensOut = session._pendingOutputTokens - session._turnTokensOutStart;
    const turnDurationMs = Date.now() - session._pendingPreflightAt;
    postflight(
      session._pendingPreflightInput,
      pending,
      session._turnToolCalls,
      Math.max(0, tokensIn),
      Math.max(0, tokensOut),
      turnDurationMs,
      session,
      store,
    ).catch(e => swallow("stop:postflight", e));
    // Clear the pending stash so the next turn starts fresh
    session._pendingPreflight = null;
    session._pendingPreflightInput = "";
    session._turnToolCalls = 0;
  }

  log.debug(`Stop: turn=${session.userTurnCount}, tokens=${session.cumulativeTokens}`);

  return {};
}
