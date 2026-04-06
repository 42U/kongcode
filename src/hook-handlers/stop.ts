/**
 * Stop hook handler.
 *
 * Turn boundary marker: ingests the assistant response, updates token
 * counters, triggers daemon extraction if threshold is reached,
 * runs cognitive check if interval is reached.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import type { TurnData } from "../engine/daemon-types.js";
import { ingestTurn } from "../context-assembler.js";
import { shouldRunCheck, runCognitiveCheck } from "../engine/cognitive-check.js";
import { evaluateRetrieval, getStagedItems } from "../engine/retrieval-quality.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

export async function handleStop(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const { store, embeddings } = state;

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

  // Cognitive check (periodic, every few turns)
  if (shouldRunCheck(session.userTurnCount, session) && store.isAvailable() && embeddings.isAvailable()) {
    try {
      await runCognitiveCheck(
        {
          sessionId: session.sessionId,
          userQuery: session.lastUserText,
          responseText: session.lastAssistantText,
          retrievedNodes: [],
          recentTurns: [],
        },
        session,
        store,
        state.complete,
      );
    } catch (e) {
      swallow("stop:cognitiveCheck", e);
    }
  }

  // Daemon flush if threshold met
  if (session.daemon && session.newContentTokens >= session.daemonTokenThreshold) {
    const turnsSinceFlush = session.userTurnCount - session.lastDaemonFlushTurnCount;
    if (turnsSinceFlush >= 2) {
      try {
        const turns: TurnData[] = [];
        if (session.lastUserText) turns.push({ role: "user", text: session.lastUserText });
        if (session.lastAssistantText) turns.push({ role: "assistant", text: session.lastAssistantText });
        session.daemon.sendTurnBatch(turns, session.pendingThinking.slice(-3), []);
        session.newContentTokens = 0;
        session.lastDaemonFlushTurnCount = session.userTurnCount;
      } catch (e) {
        swallow("stop:daemon", e);
      }
    }
  }

  log.debug(`Stop: turn=${session.userTurnCount}, tokens=${session.cumulativeTokens}`);

  return {};
}
