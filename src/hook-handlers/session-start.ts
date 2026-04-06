/**
 * SessionStart hook handler.
 *
 * Bootstraps the session: creates 5-pillar graph nodes, applies schema,
 * starts memory daemon, synthesizes wakeup briefing, runs deferred cleanup.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { seedIdentity } from "../engine/identity.js";
import { seedCognitiveBootstrap } from "../engine/cognitive-bootstrap.js";
import { synthesizeWakeup } from "../engine/wakeup.js";
import { runDeferredCleanup } from "../engine/deferred-cleanup.js";
import { startMemoryDaemon } from "../engine/daemon-manager.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

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

      // Start memory daemon for background knowledge extraction
      if (!session.daemon) {
        session.daemon = startMemoryDaemon(
          store, embeddings, session.sessionId, state.complete,
          state.config.thresholds.extractionTimeoutMs,
          session.taskId, session.projectId,
        );
      }

      // Seed identity and cognitive bootstrap (idempotent)
      await seedIdentity(store, embeddings).catch(e => swallow("sessionStart:identity", e));
      await seedCognitiveBootstrap(store, embeddings).catch(e => swallow("sessionStart:cognitive", e));

      // Run deferred cleanup for orphaned sessions
      await runDeferredCleanup(store, embeddings, state.complete).catch(e => swallow("sessionStart:deferredCleanup", e));
    } catch (e) {
      swallow.warn("sessionStart:bootstrap", e);
    }
  }

  // Synthesize wakeup briefing (async, result cached for UserPromptSubmit)
  if (store.isAvailable() && embeddings.isAvailable()) {
    session._wakeupPromise = synthesizeWakeup(store, state.complete, session.sessionId)
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

  return {
    ...(wakeupText ? { systemMessage: wakeupText } : {}),
  };
}
