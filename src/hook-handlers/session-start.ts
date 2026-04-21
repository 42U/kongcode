/**
 * SessionStart hook handler.
 *
 * Bootstraps the session: creates 5-pillar graph nodes, applies schema,
 * synthesizes wakeup briefing, runs deferred cleanup.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { seedIdentity } from "../engine/identity.js";
import { seedCognitiveBootstrap } from "../engine/cognitive-bootstrap.js";
import { synthesizeWakeup } from "../engine/wakeup.js";
import { runDeferredCleanup } from "../engine/deferred-cleanup.js";
import { getSoul } from "../engine/soul.js";
import { hasMigratableFiles } from "../engine/workspace-migrate.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { assertRecordId } from "../engine/surreal.js";
import { checkACANReadiness } from "../engine/acan.js";

export async function handleSessionStart(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getOrCreateSession(sessionId, sessionId);

  log.info(`Session start: ${sessionId}`);

  const { store, embeddings } = state;

  // Schema is applied during store.initialize() — no separate call needed.

  // Bootstrap 5-pillar nodes
  if (store.isAvailable()) {
    try {
      session.agentId = await store.ensureAgent("kongcode", "claude");

      const cwd = (payload.cwd as string) ?? state.workspaceDir ?? process.cwd();
      const projectName = cwd.split("/").pop() ?? "unknown";
      session.projectId = await store.ensureProject(projectName);

      await store.linkAgentToProject(session.agentId, session.projectId)
        .catch(e => swallow("sessionStart:linkAgentToProject", e));

      session.taskId = await store.createTask(`Session in ${projectName}`);
      await store.linkAgentToTask(session.agentId, session.taskId)
        .catch(e => swallow("sessionStart:linkAgentToTask", e));
      await store.linkTaskToProject(session.taskId, session.projectId)
        .catch(e => swallow("sessionStart:linkTaskToProject", e));

      session.surrealSessionId = await store.createSession(session.agentId);
      await store.markSessionActive(session.surrealSessionId)
        .catch(e => swallow("sessionStart:markActive", e));
      await store.linkSessionToTask(session.surrealSessionId, session.taskId)
        .catch(e => swallow("sessionStart:linkSessionToTask", e));

      // Seed identity and cognitive bootstrap (idempotent)
      await seedIdentity(store, embeddings).catch(e => swallow("sessionStart:identity", e));
      await seedCognitiveBootstrap(store, embeddings).catch(e => swallow("sessionStart:cognitive", e));

      // Run deferred cleanup for orphaned sessions
      await runDeferredCleanup(store).catch(e => swallow("sessionStart:deferredCleanup", e));

      // Check for unacknowledged graduation events from previous sessions
      try {
        const gradEvents = await store.queryFirst<{
          id: string; quality_score: number; volume_score: number;
        }>(`SELECT * FROM graduation_event WHERE acknowledged = false ORDER BY created_at DESC LIMIT 1`);
        if (gradEvents.length > 0) {
          const evt = gradEvents[0];
          const soul = await getSoul(store);
          if (soul) {
            session._graduationCelebration = {
              qualityScore: evt.quality_score,
              volumeScore: evt.volume_score,
              soulSummary: "Working style: " + soul.working_style.join("; ") +
                "\nSelf-observations: " + soul.self_observations.join("; "),
            };
            // Mark as acknowledged
            try {
              assertRecordId(evt.id);
              await store.queryExec(
                `UPDATE ${evt.id} SET acknowledged = true, acknowledged_at = time::now(), acknowledged_session = $sid`,
                { sid: session.sessionId },
              );
            } catch (e) {
              swallow("sessionStart:ackGraduation", e);
            }
            log.info("[GRADUATION] Celebration queued for context injection");
          }
        }
      } catch (e) {
        swallow("sessionStart:graduationCheck", e);
      }

      // Check for migratable workspace files
      session._hasMigratableFiles = await hasMigratableFiles(cwd)
        .catch(() => false);
    } catch (e) {
      swallow.warn("sessionStart:bootstrap", e);
    }

    // Background maintenance — ported from the dead ContextEngine.bootstrap()
    // method in KongBrain, where the OpenClaw framework used to call it on
    // session lifecycle. KongCode has no such framework call, so the five
    // jobs below had been silently not running since the port. Each has its
    // own internal safety floors (count<=200, count<=2000, count<=50) and
    // LIMITs — safe to run on every session start, safe to race with sibling
    // MCPs (second mover does wasted work, not corruption). ACAN retrain
    // carries its own lockfile from src/engine/acan.ts.
    Promise.all([
      store.runMemoryMaintenance(),
      store.archiveOldTurns(),
      store.consolidateMemories((text) => embeddings.embed(text)),
      store.garbageCollectMemories(),
      checkACANReadiness(store, state.config.thresholds.acanTrainingThreshold),
    ]).catch(e => swallow.warn("sessionStart:maintenance", e));
  }

  // Synthesize wakeup briefing (async, result cached for UserPromptSubmit)
  if (store.isAvailable() && embeddings.isAvailable()) {
    session._wakeupPromise = synthesizeWakeup(store, session.sessionId)
      .catch(e => { swallow("sessionStart:wakeup", e); return null; });
  }

  // If wakeup is fast, include it in the session start response
  let wakeupText: string | null = null;
  if (session._wakeupPromise) {
    try {
      wakeupText = await Promise.race([
        session._wakeupPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
    } catch { /* wakeup will be injected on next UserPromptSubmit */ }
  }

  return makeHookOutput("SessionStart", wakeupText ?? undefined);
}
