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
import { swallow } from "./errors.js";
// --- Thresholds ---
const UTIL_THRESHOLD = 0.2;
const TOOL_FAILURE_THRESHOLD = 0.2;
const STEERING_THRESHOLD = 1;
let _reflectionContextWindow = 200000;
export function setReflectionContextWindow(cw) {
    _reflectionContextWindow = cw;
}
function getWasteThreshold() {
    return Math.round(_reflectionContextWindow * 0.005);
}
// --- Reflection Generation ---
/**
 * Gather session metrics and determine if reflection is warranted.
 */
export async function gatherSessionMetrics(sessionId, store) {
    if (!store.isAvailable())
        return null;
    try {
        const metricsRows = await store.queryFirst(`SELECT
         count() AS totalTurns,
         math::sum(actual_tool_calls) AS totalTools,
         math::sum(steering_candidates) AS totalSteering
       FROM orchestrator_metrics WHERE session_id = $sid GROUP ALL`, { sid: sessionId });
        const metrics = metricsRows[0];
        const qualityRows = await store.queryFirst(`SELECT
         count() AS totalRetrievals,
         math::mean(utilization) AS avgUtil,
         math::sum(context_tokens) AS totalContextTokens,
         math::sum(IF tool_success = false THEN 1 ELSE 0 END) AS toolFailures,
         math::sum(IF utilization < 0.1 THEN context_tokens ELSE 0 END) AS wastedTokens
       FROM retrieval_outcome WHERE session_id = $sid GROUP ALL`, { sid: sessionId });
        const quality = qualityRows[0];
        const totalTurns = Number(metrics?.totalTurns ?? 0);
        const totalTools = Number(metrics?.totalTools ?? 0);
        const totalSteering = Number(metrics?.totalSteering ?? 0);
        const rawRetrievals = Number(quality?.totalRetrievals ?? 0);
        const totalRetrievals = Number.isFinite(rawRetrievals) ? rawRetrievals : 0;
        const rawUtil = Number(quality?.avgUtil ?? 1);
        const avgUtilization = Number.isFinite(rawUtil) ? rawUtil : 1;
        const rawFailures = Number(quality?.toolFailures ?? 0);
        const toolFailures = Number.isFinite(rawFailures) ? rawFailures : 0;
        const rawWasted = Number(quality?.wastedTokens ?? 0);
        const wastedTokens = Number.isFinite(rawWasted) ? rawWasted : 0;
        const toolFailureRate = totalRetrievals > 0 ? toolFailures / totalRetrievals : 0;
        return {
            avgUtilization,
            toolFailureRate,
            steeringCandidates: totalSteering,
            wastedTokens,
            totalToolCalls: totalTools,
            totalTurns,
        };
    }
    catch (e) {
        swallow.warn("reflection:gatherMetrics", e);
        return null;
    }
}
/**
 * Determine if session performance warrants a reflection.
 */
export function shouldReflect(metrics) {
    const reasons = [];
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
export async function generateReflection(sessionId, store, embeddings, surrealSessionId) {
    if (!store.isAvailable())
        return;
    // Gate: only reflect if session metrics warrant it
    const metrics = await gatherSessionMetrics(sessionId, store);
    if (metrics) {
        const { reflect } = shouldReflect(metrics);
        if (!reflect)
            return;
    }
    // LLM call logic removed — reflection writes are now handled by
    // the subagent-driven pending_work pipeline (commit_work_results tool).
}
// --- Reflection Retrieval ---
/**
 * Vector search on the reflection table.
 *
 * 0.7.26: optional projectId scopes reflections to those originating from
 * sessions in the same project (or marked scope='global'). Reflections are
 * session-keyed and sessions are project-keyed via task_part_of, so we filter
 * by traversing reflection.session_id → session.project_id. Soft filter:
 * reflections without a resolvable project still surface (back-compat).
 */
export async function retrieveReflections(queryVec, limit = 3, store, projectId) {
    if (!store?.isAvailable())
        return [];
    try {
        const projectFilter = projectId
            ? ` AND (project_id IS NONE OR project_id = $pid OR scope = 'global'
               OR session_id IN (SELECT id FROM session WHERE project_id = $pid))`
            : "";
        const bindings = { vec: queryVec, lim: limit };
        if (projectId)
            bindings.pid = projectId;
        const rows = await store.queryFirst(`SELECT id, text, category, severity, importance,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection
       WHERE embedding != NONE AND array::len(embedding) > 0${projectFilter}
       ORDER BY score DESC LIMIT $lim`, bindings);
        return rows
            .filter((r) => (r.score ?? 0) > 0.35)
            .map((r) => ({
            id: String(r.id),
            text: r.text ?? "",
            category: r.category ?? "efficiency",
            severity: r.severity ?? "minor",
            importance: Number(r.importance ?? 7.0),
            score: r.score,
        }));
    }
    catch (e) {
        swallow.warn("reflection:retrieve", e);
        return [];
    }
}
/**
 * Format reflections as a context block for the LLM.
 */
export function formatReflectionContext(reflections) {
    if (reflections.length === 0)
        return "";
    const lines = reflections.map((r) => {
        return `[reflection/${r.category}] ${r.text}`;
    });
    return `\n<reflection_context>\n[Lessons from past sessions — avoid repeating these mistakes]\n${lines.join("\n\n")}\n</reflection_context>`;
}
/**
 * Get reflection count (for /stats display).
 */
export async function getReflectionCount(store) {
    try {
        if (!store.isAvailable())
            return 0;
        const rows = await store.queryFirst(`SELECT count() AS count FROM reflection GROUP ALL`);
        return Number(rows[0]?.count ?? 0);
    }
    catch (e) {
        swallow.warn("reflection:count", e);
        return 0;
    }
}
