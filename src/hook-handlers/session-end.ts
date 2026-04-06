/**
 * SessionEnd hook handler.
 *
 * Runs final cleanup: daemon flush, skill extraction, reflection,
 * soul graduation, handoff note. Mirrors KongBrain's session_end logic.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { extractSkill } from "../engine/skills.js";
import { generateReflection } from "../engine/reflection.js";
import { graduateCausalToSkills } from "../engine/skills.js";
import { attemptGraduation, evolveSoul, checkStageTransition } from "../engine/soul.js";
import { writeHandoffFileSync } from "../engine/handoff-file.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

export async function handleSessionEnd(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session || session.cleanedUp) return {};

  log.info(`Session end: ${sessionId}`);

  const { store, embeddings } = state;
  session.cleanedUp = true;

  if (!store.isAvailable()) return {};

  // Run cleanup operations in parallel
  const ops: Promise<unknown>[] = [];

  // Skill extraction
  if (session.userTurnCount >= 4) {
    ops.push(
      extractSkill(session.sessionId, session.taskId, store, embeddings, state.complete)
        .catch(e => swallow.warn("sessionEnd:skillExtract", e)),
    );
  }

  // Reflection
  ops.push(
    generateReflection(session.sessionId, store, embeddings, state.complete, session.surrealSessionId)
      .catch(e => swallow.warn("sessionEnd:reflection", e)),
  );

  // Causal chain graduation
  ops.push(
    graduateCausalToSkills(store, embeddings, state.complete)
      .catch(e => swallow.warn("sessionEnd:causalGrad", e)),
  );

  // Soul graduation
  ops.push(
    (async () => {
      const gradResult = await attemptGraduation(store, state.complete);
      if (gradResult.graduated) {
        log.info("[GRADUATION] KongCode has achieved soul graduation!");
      } else {
        await evolveSoul(store, state.complete);
      }
    })().catch(e => swallow.warn("sessionEnd:soul", e)),
  );

  // Stage transition check
  ops.push(
    checkStageTransition(store).then(transition => {
      if (transition.transitioned) {
        log.info(`[MATURITY] ${transition.previousStage ?? "nascent"} → ${transition.currentStage}`);
      }
    }).catch(e => swallow("sessionEnd:stageTransition", e)),
  );

  await Promise.allSettled(ops);

  // Mark session ended in DB
  try {
    await store.endSession(session.surrealSessionId);
  } catch (e) {
    swallow.warn("sessionEnd:endSession", e);
  }

  // Write handoff file (sync, for crash safety)
  try {
    writeHandoffFileSync({
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      userTurnCount: session.userTurnCount,
      lastUserText: session.lastUserText.slice(0, 500),
      lastAssistantText: session.lastAssistantText.slice(0, 500),
      unextractedTokens: session.newContentTokens,
    }, state.workspaceDir ?? process.cwd());
  } catch (e) {
    swallow.warn("sessionEnd:handoff", e);
  }

  // Cleanup session from state
  state.removeSession(sessionId);

  return {};
}
