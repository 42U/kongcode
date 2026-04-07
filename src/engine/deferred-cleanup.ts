/**
 * Deferred Cleanup — queue work for orphaned sessions.
 *
 * When the process dies abruptly (Ctrl+C×2), session cleanup never runs.
 * On next session start, this module finds orphaned sessions (started but
 * never marked cleanup_completed), queues pending_work items for subagent
 * processing, and marks them ended.
 *
 * No LLM calls — all intelligence runs through Claude subagents via pending_work.
 */
import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

// Process-global flag — deferred cleanup runs AT MOST ONCE per process.
// Using Symbol.for so it survives Jiti re-importing this module.
const RAN_KEY = Symbol.for("kongbrain.deferredCleanup.ran");
const _g = globalThis as Record<symbol, unknown>;

/**
 * Find orphaned sessions and queue pending_work for subagent processing.
 * Fire-and-forget from session_start — does not block the new session.
 * Only runs once per process lifetime.
 */
export async function runDeferredCleanup(
  store: SurrealStore,
): Promise<number> {
  // Once per process — never re-run even if first run times out
  if (_g[RAN_KEY]) return 0;
  _g[RAN_KEY] = true;

  try {
    return await runDeferredCleanupInner(store);
  } catch (e) {
    swallow.warn("deferredCleanup:outer", e);
    return 0;
  }
}

async function runDeferredCleanupInner(
  store: SurrealStore,
): Promise<number> {
  if (!store.isAvailable()) return 0;

  const orphaned = await store.getOrphanedSessions(10).catch(() => []);
  if (orphaned.length === 0) return 0;

  let processed = 0;

  for (const session of orphaned) {
    try {
      // Queue extraction work
      await store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "extraction",
          session_id: "deferred",
          surreal_session_id: session.id,
          payload: { source: "deferred_cleanup" },
          priority: 1,
        },
      }).catch(e => swallow("deferred:queueExtraction", e));

      // Queue handoff note
      await store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "handoff_note",
          session_id: "deferred",
          surreal_session_id: session.id,
          priority: 2,
        },
      }).catch(e => swallow("deferred:queueHandoff", e));

      // Mark session ended so it won't be picked up again
      await store.markSessionEnded(session.id).catch(e => swallow("deferred:markEnded", e));

      log.info(`[deferred] queued work for orphaned session ${session.id}`);
      processed++;
    } catch (e) {
      swallow.warn("deferredCleanup:session", e);
    }
  }

  return processed;
}
