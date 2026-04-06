/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as systemMessage.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { assembleContextString, ingestTurn } from "../context-assembler.js";
import { log } from "../engine/log.js";

export async function handleUserPromptSubmit(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId) ?? state.getOrCreateSession(sessionId, sessionId);

  // Reset per-turn state
  session.resetTurn();

  const userPrompt = (payload.user_prompt as string) ?? "";
  if (!userPrompt) return {};

  session.lastUserText = userPrompt;

  // Ingest user message into graph (async, don't block context assembly)
  ingestTurn(state, session, "user", userPrompt).catch(() => {});

  // Run full context retrieval pipeline
  const contextString = await assembleContextString(state, session, userPrompt);

  log.debug(`UserPromptSubmit: session=${sessionId}, context=${contextString ? "injected" : "none"}`);

  return {
    ...(contextString ? { systemMessage: contextString } : {}),
  };
}
