/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as systemMessage.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { log } from "../engine/log.js";

export async function handleUserPromptSubmit(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId) ?? state.getOrCreateSession(sessionId, sessionId);

  // Reset per-turn state
  session.resetTurn();
  session.userTurnCount++;

  const userPrompt = (payload.user_prompt as string) ?? "";
  if (!userPrompt) return {};

  session.lastUserText = userPrompt;

  // TODO: Phase 4 will implement the full context pipeline here:
  // 1. classifyIntent(userPrompt)
  // 2. vectorSearch across 7 tables
  // 3. graphExpand neighbors
  // 4. WMR/ACAN scoring
  // 5. dedup + budget trim
  // 6. format as systemMessage

  log.debug(`UserPromptSubmit: session=${sessionId}, prompt=${userPrompt.slice(0, 80)}...`);

  return {};
}
