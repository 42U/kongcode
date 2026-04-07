/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as additionalContext.
 *
 * On the first turn of a new session, also checks for pending background
 * work and instructs Claude to spawn a subagent to process it.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { assembleContextString, ingestTurn } from "../context-assembler.js";
import { swallow } from "../engine/errors.js";
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

  // On first turn, check for pending background work from previous sessions
  let pendingWorkMessage = "";
  if (session.userTurnCount <= 1 && state.store.isAvailable()) {
    try {
      const pending = await state.store.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM pending_work WHERE status = "pending" GROUP ALL`,
      );
      const count = pending[0]?.count ?? 0;
      if (count > 0) {
        pendingWorkMessage = `\n\n<kongcode_pending_work>
KongCode has ${count} pending memory operation${count > 1 ? "s" : ""} from previous sessions (extraction, reflection, skills, soul).

IMPORTANT: Spawn a background agent to process these. Use:
- subagent_type: "kongcode:memory-extractor"
- model: opus (highest intelligence for knowledge extraction)
- run_in_background: true
- Prompt: "Process all pending KongCode memory work. Loop: call fetch_pending_work to get the next item, analyze the data according to the instructions provided, then call commit_work_results with your output. Repeat until fetch_pending_work returns empty. Be thorough in your extractions — this is the intelligence layer."

This runs silently in the background. Respond to the user normally.
</kongcode_pending_work>`;
        log.info(`[pending_work] ${count} items queued for subagent processing`);
      }
    } catch (e) {
      swallow("userPromptSubmit:pendingCheck", e);
    }
  }

  const additionalContext = [contextString, pendingWorkMessage].filter(Boolean).join("") || undefined;

  log.debug(`UserPromptSubmit: session=${sessionId}, context=${contextString ? "injected" : "none"}, pending=${pendingWorkMessage ? "yes" : "no"}`);

  return makeHookOutput("UserPromptSubmit", additionalContext);
}
