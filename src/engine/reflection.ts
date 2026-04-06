/**
 * Metacognitive Reflection
 *
 * At session end, reviews own performance: tool failures, runaway detections,
 * low retrieval utilization, wasted tokens. If problems exceeded thresholds,
 * generates a structured reflection via the configured LLM, stored as high-importance memory.
 * Retrieved when similar situations arise in future sessions.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { CompleteFn } from "./state.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";

// --- Types ---

export interface ReflectionMetrics {
  avgUtilization: number;
  toolFailureRate: number;
  steeringCandidates: number;
  wastedTokens: number;
  totalToolCalls: number;
  totalTurns: number;
}

export interface Reflection {
  id: string;
  text: string;
  category: string;
  severity: string;
  importance: number;
  score?: number;
}

// --- Thresholds ---

const UTIL_THRESHOLD = 0.2;
const TOOL_FAILURE_THRESHOLD = 0.2;
const STEERING_THRESHOLD = 1;

let _reflectionContextWindow = 200000;

export function setReflectionContextWindow(cw: number): void {
  _reflectionContextWindow = cw;
}

function getWasteThreshold(): number {
  return Math.round(_reflectionContextWindow * 0.005);
}

// --- Reflection Generation ---

/**
 * Gather session metrics and determine if reflection is warranted.
 */
export async function gatherSessionMetrics(
  sessionId: string,
  store: SurrealStore,
): Promise<ReflectionMetrics | null> {
  if (!store.isAvailable()) return null;

  try {
    const metricsRows = await store.queryFirst<any>(
      `SELECT
         count() AS totalTurns,
         math::sum(actual_tool_calls) AS totalTools,
         math::sum(steering_candidates) AS totalSteering
       FROM orchestrator_metrics WHERE session_id = $sid GROUP ALL`,
      { sid: sessionId },
    );
    const metrics = metricsRows[0];

    const qualityRows = await store.queryFirst<any>(
      `SELECT
         count() AS totalRetrievals,
         math::mean(utilization) AS avgUtil,
         math::sum(context_tokens) AS totalContextTokens,
         math::sum(IF tool_success = false THEN 1 ELSE 0 END) AS toolFailures,
         math::sum(IF utilization < 0.1 THEN context_tokens ELSE 0 END) AS wastedTokens
       FROM retrieval_outcome WHERE session_id = $sid GROUP ALL`,
      { sid: sessionId },
    );
    const quality = qualityRows[0];

    const totalTurns = Number(metrics?.totalTurns ?? 0);
    const totalTools = Number(metrics?.totalTools ?? 0);
    const totalSteering = Number(metrics?.totalSteering ?? 0);
    const totalRetrievals = Number(quality?.totalRetrievals ?? 0);
    const avgUtilization = Number(quality?.avgUtil ?? 1);
    const toolFailures = Number(quality?.toolFailures ?? 0);
    const wastedTokens = Number(quality?.wastedTokens ?? 0);

    const toolFailureRate = totalRetrievals > 0 ? toolFailures / totalRetrievals : 0;

    return {
      avgUtilization,
      toolFailureRate,
      steeringCandidates: totalSteering,
      wastedTokens,
      totalToolCalls: totalTools,
      totalTurns,
    };
  } catch (e) {
    swallow.warn("reflection:gatherMetrics", e);
    return null;
  }
}

/**
 * Determine if session performance warrants a reflection.
 */
export function shouldReflect(metrics: ReflectionMetrics): { reflect: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (metrics.avgUtilization < UTIL_THRESHOLD && metrics.totalTurns > 1) {
    reasons.push(`Low retrieval utilization: ${(metrics.avgUtilization * 100).toFixed(0)}% (threshold: ${UTIL_THRESHOLD * 100}%)`);
  }
  if (metrics.toolFailureRate > TOOL_FAILURE_THRESHOLD) {
    reasons.push(`High tool failure rate: ${(metrics.toolFailureRate * 100).toFixed(0)}% (threshold: ${TOOL_FAILURE_THRESHOLD * 100}%)`);
  }
  if (metrics.steeringCandidates >= STEERING_THRESHOLD) {
    reasons.push(`${metrics.steeringCandidates} steering candidate(s) detected`);
  }
  if (metrics.wastedTokens > getWasteThreshold()) {
    reasons.push(`~${metrics.wastedTokens} wasted context tokens`);
  }

  return { reflect: reasons.length > 0, reasons };
}

/**
 * Generate a structured reflection from session performance data.
 * Only called when shouldReflect() returns true.
 */
export async function generateReflection(
  sessionId: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
  surrealSessionId?: string,
): Promise<void> {
  if (!store.isAvailable()) return;

  // Gate: only reflect if session metrics warrant it
  const metrics = await gatherSessionMetrics(sessionId, store);
  if (metrics) {
    const { reflect } = shouldReflect(metrics);
    if (!reflect) return;
  }

  // Get session turns directly — no dependency on orchestrator_metrics
  const turns = await store.getSessionTurns(sessionId, 15).catch(() => []);
  if (turns.length < 3) return; // Too short for meaningful reflection

  const transcript = turns
    .map(t => `[${t.role}] ${(t.text ?? "").slice(0, 300)}`)
    .join("\n");

  const severity = turns.length >= 15 ? "moderate" : "minor";
  const category = "session_review";

  try {
    const response = await complete({
      system: `Reflect on this session. Write 2-4 sentences about: what went well, what could improve, any patterns worth noting. Be specific and actionable. If the session was too trivial for reflection, respond with just "skip".`,
      messages: [{
        role: "user",
        content: `Session with ${turns.length} turns:\n${transcript.slice(0, 15000)}`,
      }],
    });

    const reflectionText = response.text.trim();

    if (reflectionText.length < 20 || reflectionText.toLowerCase() === "skip") return;

    let reflEmb: number[] | null = null;
    if (embeddings.isAvailable()) {
      try { reflEmb = await embeddings.embed(reflectionText); } catch (e) { swallow("reflection:ok", e); }
    }

    // Dedup: skip if a very similar reflection already exists
    if (reflEmb?.length) {
      const existing = await store.queryFirst<{ id: string; importance: number; score: number }>(
        `SELECT id, importance,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM reflection
         WHERE embedding != NONE AND array::len(embedding) > 0
         ORDER BY score DESC LIMIT 1`,
        { vec: reflEmb },
      );
      const top = existing[0];
      if (top && typeof top.score === "number" && top.score > 0.85) {
        const newImportance = Math.min(10, (top.importance ?? 7) + 0.5);
        await store.queryFirst<any>(
          `UPDATE $id SET importance = $imp, updated_at = time::now()`,
          { id: top.id, imp: newImportance },
        );
        return;
      }
    }

    const record: Record<string, unknown> = {
      session_id: sessionId,
      text: reflectionText,
      category,
      severity,
      importance: 7.0,
    };
    if (reflEmb?.length) record.embedding = reflEmb;

    const rows = await store.queryFirst<{ id: string }>(
      `CREATE reflection CONTENT $record RETURN id`,
      { record },
    );
    const reflectionId = String(rows[0]?.id ?? "");
    store.clearReflectionCache();

    if (reflectionId && surrealSessionId) {
      await store.relate(reflectionId, "reflects_on", surrealSessionId).catch(e => swallow.warn("reflection:relate", e));
    }
  } catch (e) {
    swallow("reflection:silent", e);
  }
}

// --- Reflection Retrieval ---

/**
 * Vector search on the reflection table.
 */
export async function retrieveReflections(
  queryVec: number[],
  limit = 3,
  store?: SurrealStore,
): Promise<Reflection[]> {
  if (!store?.isAvailable()) return [];

  try {
    const rows = await store.queryFirst<any>(
      `SELECT id, text, category, severity, importance,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection
       WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT $lim`,
      { vec: queryVec, lim: limit },
    );

    return rows
      .filter((r: any) => (r.score ?? 0) > 0.35)
      .map((r: any) => ({
        id: String(r.id),
        text: r.text ?? "",
        category: r.category ?? "efficiency",
        severity: r.severity ?? "minor",
        importance: Number(r.importance ?? 7.0),
        score: r.score,
      }));
  } catch (e) {
    swallow.warn("reflection:retrieve", e);
    return [];
  }
}

/**
 * Format reflections as a context block for the LLM.
 */
export function formatReflectionContext(reflections: Reflection[]): string {
  if (reflections.length === 0) return "";

  const lines = reflections.map((r) => {
    return `[reflection/${r.category}] ${r.text}`;
  });

  return `\n<reflection_context>\n[Lessons from past sessions — avoid repeating these mistakes]\n${lines.join("\n\n")}\n</reflection_context>`;
}

/**
 * Get reflection count (for /stats display).
 */
export async function getReflectionCount(store: SurrealStore): Promise<number> {
  try {
    if (!store.isAvailable()) return 0;
    const rows = await store.queryFirst<{ count: number }>(`SELECT count() AS count FROM reflection GROUP ALL`);
    return Number(rows[0]?.count ?? 0);
  } catch (e) {
    swallow.warn("reflection:count", e);
    return 0;
  }
}
