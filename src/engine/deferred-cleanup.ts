/**
 * Deferred Cleanup — extract knowledge from orphaned sessions.
 *
 * When the process dies abruptly (Ctrl+C×2), session cleanup never runs.
 * On next session start, this module finds orphaned sessions (started but
 * never marked cleanup_completed), loads their turns, runs daemon extraction,
 * generates a handoff note, and marks them complete.
 *
 * Turns are already persisted via afterTurn → ingest. This just processes them.
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { CompleteFn } from "./state.js";
import { buildSystemPrompt, buildTranscript, writeExtractionResults } from "./memory-daemon.js";
import type { PriorExtractions } from "./daemon-types.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

// Process-global flag — deferred cleanup runs AT MOST ONCE per process.
// Using Symbol.for so it survives Jiti re-importing this module.
const RAN_KEY = Symbol.for("kongbrain.deferredCleanup.ran");
const _g = globalThis as Record<symbol, unknown>;

/**
 * Find and process orphaned sessions. Runs with a 30s total timeout.
 * Fire-and-forget from session_start — does not block the new session.
 * Only runs once per process lifetime.
 */
export async function runDeferredCleanup(
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
): Promise<number> {
  // Once per process — never re-run even if first run times out
  if (_g[RAN_KEY]) return 0;
  _g[RAN_KEY] = true;

  try {
    return await runDeferredCleanupInner(store, embeddings, complete);
  } catch (e) {
    swallow.warn("deferredCleanup:outer", e);
    return 0;
  }
}

async function runDeferredCleanupInner(
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
): Promise<number> {
  if (!store.isAvailable()) return 0;

  const orphaned = await store.getOrphanedSessions(10).catch(() => []);
  if (orphaned.length === 0) return 0;

  let processed = 0;

  const cleanup = async () => {
    for (const session of orphaned) {
      try {
        // Claim each session just before processing so unclaimed ones remain
        // available to the next run if we time out partway through
        await store.markSessionEnded(session.id).catch(e => swallow("deferred:claim", e));
        await processOrphanedSession(session.id, store, embeddings, complete);
        processed++;
      } catch (e) {
        swallow.warn("deferredCleanup:session", e);
      }
    }
  };

  // 90s timeout — each session needs ~6s (2 LLM calls), 10 sessions ≈ 60s
  await Promise.race([
    cleanup(),
    new Promise<void>(resolve => setTimeout(resolve, 90_000)),
  ]);

  return processed;
}

async function processOrphanedSession(
  surrealSessionId: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
): Promise<void> {
  // Load turns for extraction via part_of edges (turn->part_of->session)
  const turns = await store.queryFirst<{ id: string; role: string; text: string; tool_name?: string }>(
    `SELECT id, role, text, tool_name, created_at FROM turn
     WHERE id IN (SELECT VALUE in FROM part_of WHERE out = $sid)
     ORDER BY created_at ASC LIMIT 50`,
    { sid: surrealSessionId },
  ).catch(() => []);

  if (turns.length < 2) {
    return;
  }

  // Run daemon extraction
  const priorState: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
  const turnData = turns.map(t => ({ turnId: String(t.id), role: t.role, text: t.text, tool_name: t.tool_name }));
  const transcript = buildTranscript(turnData);
  const systemPrompt = buildSystemPrompt(false, false, priorState);

  try {
    log.info(`[deferred] extracting session ${surrealSessionId} (${turns.length} turns, transcript ${transcript.length} chars)`);
    const LLM_CALL_TIMEOUT_MS = 120_000;
    const response = await Promise.race([
      complete({
        system: systemPrompt,
        messages: [{ role: "user", content: `[TRANSCRIPT]\n${transcript.slice(0, 60000)}` }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM extraction call timed out")), LLM_CALL_TIMEOUT_MS),
      ),
    ]);

    const responseText = response.text;
    log.info(`[deferred] extraction response: ${responseText.length} chars`);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let result: Record<string, any>;
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        try {
          result = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, "$1"));
        } catch { result = {}; }
      }
      // Strip prototype pollution keys from LLM-generated JSON
      const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
      for (const key of Object.keys(result)) {
        if (BANNED_KEYS.has(key)) delete result[key];
      }

      const keys = Object.keys(result);
      log.info(`[deferred] parsed ${keys.length} keys: ${keys.join(", ")}`);
      if (keys.length > 0) {
        await writeExtractionResults(result, surrealSessionId, store, embeddings, priorState, undefined, undefined, turnData);
        log.info(`[deferred] wrote extraction results for ${surrealSessionId}`);
      }
    } else {
      log.warn(`[deferred] no JSON found in response`);
    }
  } catch (e) {
    swallow.warn("deferredCleanup:extraction", e);
  }

  // Generate handoff note
  try {
    const lastTurns = turns.slice(-15);
    const turnSummary = lastTurns
      .map(t => `[${t.role}] ${t.text.slice(0, 200)}`)
      .join("\n");

    const handoffResponse = await Promise.race([
      complete({
        system: "Summarize this session for handoff to your next self. What was worked on, what's unfinished, what to remember. 2-3 sentences. Write in first person.",
        messages: [{ role: "user", content: turnSummary }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM handoff call timed out")), 30_000),
      ),
    ]);

    const handoffText = handoffResponse.text.trim();
    log.info(`[deferred] handoff response: ${handoffText.length} chars`);
    if (handoffText.length > 20) {
      let emb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { emb = await embeddings.embed(handoffText); } catch { /* ok */ }
      }
      await store.createMemory(handoffText, emb, 8, "handoff", surrealSessionId);
    }
  } catch (e) {
    swallow.warn("deferredCleanup:handoff", e);
  }
}
