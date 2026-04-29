/**
 * SessionEnd hook handler.
 *
 * Queues cognitive work (extraction, reflection, skills, soul) to the
 * pending_work table for processing by a subagent on the next session.
 * No LLM calls — all intelligence runs through Claude subagents.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { hasSoul, checkStageTransition } from "../engine/soul.js";
import { writeHandoffFileSync } from "../engine/handoff-file.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { triggerDrainCheck } from "../daemon/auto-drain.js";

export async function handleSessionEnd(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session || session.cleanedUp) return {};

  log.info(`Session end: ${sessionId}`);

  const { store } = state;
  session.cleanedUp = true;

  if (!store.isAvailable()) return {};

  // Queue cognitive work for subagent processing on next session
  const queueOps: Promise<unknown>[] = [];

  // Extraction — always queue if session had meaningful conversation
  if (session.userTurnCount >= 2) {
    queueOps.push(
      store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "extraction",
          session_id: session.sessionId,
          surreal_session_id: session.surrealSessionId,
          task_id: session.taskId,
          project_id: session.projectId,
          payload: { turn_count: session.userTurnCount },
          priority: 1,
        },
      }).catch(e => swallow("sessionEnd:queueExtraction", e)),
    );
  }

  // Handoff note — high priority, needed for next wakeup
  if (session.userTurnCount >= 2) {
    queueOps.push(
      store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "handoff_note",
          session_id: session.sessionId,
          surreal_session_id: session.surrealSessionId,
          priority: 2,
        },
      }).catch(e => swallow("sessionEnd:queueHandoff", e)),
    );
  }

  // Reflection — needs 3+ turns for meaningful analysis
  if (session.userTurnCount >= 3) {
    queueOps.push(
      store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "reflection",
          session_id: session.sessionId,
          surreal_session_id: session.surrealSessionId,
          priority: 3,
        },
      }).catch(e => swallow("sessionEnd:queueReflection", e)),
    );
  }

  // Skill extraction — needs 4+ turns for meaningful patterns
  if (session.userTurnCount >= 4) {
    queueOps.push(
      store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "skill_extract",
          session_id: session.sessionId,
          task_id: session.taskId,
          priority: 5,
        },
      }).catch(e => swallow("sessionEnd:queueSkill", e)),
    );
  }

  // Causal chain graduation
  queueOps.push(
    store.queryExec(`CREATE pending_work CONTENT $data`, {
      data: {
        work_type: "causal_graduate",
        session_id: session.sessionId,
        priority: 7,
      },
    }).catch(e => swallow("sessionEnd:queueCausal", e)),
  );

  // Soul graduation or evolution
  const soulExists = await hasSoul(store).catch(() => false);
  queueOps.push(
    store.queryExec(`CREATE pending_work CONTENT $data`, {
      data: {
        work_type: soulExists ? "soul_evolve" : "soul_generate",
        session_id: session.sessionId,
        priority: 9,
      },
    }).catch(e => swallow("sessionEnd:queueSoul", e)),
  );

  await Promise.allSettled(queueOps);

  // Stage transition check (no LLM needed — reads DB directly)
  try {
    const transition = await checkStageTransition(store);
    if (transition.transitioned) {
      log.info(`[MATURITY] ${transition.previousStage ?? "nascent"} → ${transition.currentStage}`);
    }
  } catch (e) {
    swallow("sessionEnd:stageTransition", e);
  }

  // Mark session ended in DB. Guard on surrealSessionId being set —
  // pre-0.7.4 sessions on `claude --resume` never had a row created (no
  // SessionStart hook + no UserPromptSubmit backfill), so endSession
  // would throw "Invalid record ID format: " on an empty string.
  if (session.surrealSessionId) {
    try {
      await store.endSession(session.surrealSessionId);
    } catch (e) {
      swallow.warn("sessionEnd:endSession", e);
    }
  }

  // Write handoff file (sync, for crash safety)
  try {
    writeHandoffFileSync({
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      userTurnCount: session.userTurnCount,
      lastUserText: session.lastUserText.slice(0, 500),
      lastAssistantText: session.lastAssistantText.slice(0, 500),
      unextractedTokens: 0,
    }, state.workspaceDir ?? process.cwd());
  } catch (e) {
    swallow.warn("sessionEnd:handoff", e);
  }

  // Cleanup session from state
  state.removeSession(sessionId);

  // Trigger auto-drain — this session just queued 5-6 items; let the
  // scheduler decide whether to spawn a headless extractor right now
  // (gated by threshold + PID-file lock). Fire-and-forget. No-op when
  // KONGCODE_AUTO_DRAIN=0 or queue is below threshold.
  triggerDrainCheck(
    state,
    {
      threshold: Number(process.env.KONGCODE_AUTO_DRAIN_THRESHOLD ?? 5),
      intervalMs: 0,
      cacheDir: state.config.paths.cacheDir,
      maxDaily: Number(process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY ?? 50),
    },
    "session-end",
  );

  return {};
}
