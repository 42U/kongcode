/**
 * Soul — the emergent identity document system.
 *
 * Unlike hardcoded identity chunks, the Soul document is written BY the agent
 * based on its own graph data. It lives in SurrealDB as `soul:laqrumbrain` and
 * evolves over time through experience-grounded revisions.
 *
 * Graduation is a staged process, not a binary gate. There are 8 gates total:
 * 7 volume thresholds + 1 quality gate (composite ≥ 0.85).
 *
 *   nascent    (0-4/8)  — Too early. Keep building experience.
 *   developing (5/8)    — Some signal. Diagnose weak areas, guide focus.
 *   emerging   (6/8)    — Volume is there. Quality gate becomes the blocker.
 *   maturing   (7/8)    — Either 6 volume + quality OR 7 volume - quality short.
 *   ready      (8/8)    — All 7 volume thresholds met AND quality ≥ 0.85.
 *
 * Quality is computed from actual performance signals: retrieval utilization,
 * skill success rates, reflection severity distribution, and tool failure rates.
 * An agent that meets all 7 volume thresholds but has terrible quality scores
 * will NOT graduate — it needs to improve before self-authoring makes sense.
 *
 * Ported from laqrumbrain — takes SurrealStore/EmbeddingService as params.
 */
import { type SurrealStore } from "./surreal.js";
export type MaturityStage = "nascent" | "developing" | "emerging" | "maturing" | "ready";
export interface GraduationSignals {
    sessions: number;
    reflections: number;
    causalChains: number;
    concepts: number;
    skills: number;
    monologues: number;
    spanDays: number;
}
export interface QualitySignals {
    /** Average retrieval utilization (0-1). Higher = retrieved context was actually used. */
    avgRetrievalUtilization: number;
    /** Skill success rate (0-1). successCount / (successCount + failureCount). */
    skillSuccessRate: number;
    /** Fraction of reflections that are "critical" severity. Lower is better. */
    criticalReflectionRate: number;
    /** Tool failure rate across sessions (0-1). Lower is better. */
    toolFailureRate: number;
    /** Number of data points behind the quality signals. */
    sampleSize: number;
}
export interface StageDiagnostic {
    area: string;
    status: "healthy" | "warning" | "critical";
    detail: string;
    suggestion: string;
}
export interface GraduationReport {
    /** Whether the agent is ready for soul creation. */
    ready: boolean;
    /** Current maturity stage. */
    stage: MaturityStage;
    /** Volume signals (counts). */
    signals: GraduationSignals;
    /** Static thresholds. */
    thresholds: GraduationSignals;
    /** Which thresholds are met (formatted strings). */
    met: string[];
    /** Which thresholds are unmet (formatted strings). */
    unmet: string[];
    /** Volume score (met / total). */
    volumeScore: number;
    /** Quality signals from actual performance data. */
    quality: QualitySignals;
    /** Composite quality score (0-1). Must be ≥ 0.85 to graduate. */
    qualityScore: number;
    /** Per-area diagnostics with actionable suggestions. */
    diagnostics: StageDiagnostic[];
}
/**
 * Compute quality signals from actual performance data in the graph.
 * These represent HOW WELL the agent is performing, not just how much.
 */
export declare function getQualitySignals(store: SurrealStore): Promise<QualitySignals>;
/**
 * Compute a composite quality score from individual quality signals.
 *
 * Weights:
 *   - Retrieval utilization: 30% (are we pulling useful context?)
 *   - Skill success rate: 25% (are learned procedures working?)
 *   - Critical reflection rate: 25% (inverted — fewer critical = better)
 *   - Tool failure rate: 20% (inverted — fewer failures = better)
 *
 * With insufficient data (sampleSize < 10), the score is penalized to prevent
 * premature graduation from low-activity agents that happen to have clean stats.
 */
export declare function computeQualityScore(q: QualitySignals): number;
/**
 * Check graduation readiness with full stage classification and quality analysis.
 *
 * The `met` / `unmet` arrays cover all 8 gates: the 7 volume thresholds plus
 * the 1 quality gate (composite ≥ 0.85). `met.length / 8` is the natural
 * fraction-met display. `volumeScore` remains volume-only (out of 7) so callers
 * that want the volume-vs-quality split can still see them separately.
 */
export declare function checkGraduation(store: SurrealStore): Promise<GraduationReport>;
export interface SoulDocument {
    id: string;
    agent_id: string;
    working_style: string[];
    emotional_dimensions: {
        dimension: string;
        description: string;
        adopted_at: string;
    }[];
    self_observations: string[];
    earned_values: {
        value: string;
        grounded_in: string;
    }[];
    revisions: {
        timestamp: string;
        section: string;
        change: string;
        rationale: string;
    }[];
    created_at: string;
    updated_at: string;
}
export declare function hasSoul(store: SurrealStore): Promise<boolean>;
export declare function getSoul(store: SurrealStore): Promise<SoulDocument | null>;
/** Outcome of a createSoul attempt. "exists" covers BOTH the up-front
 *  already-exists check AND the K42 create-race loss — in each case the soul
 *  is present but THIS call did not author it, so callers must not run
 *  author-only side effects (graduation event, core-memory seed). The old
 *  boolean conflated race-loss with authorship (both `true`), which let two
 *  concurrent soul_generate commits each record a graduation_event — the
 *  double-celebration bug. */
export type CreateSoulOutcome = "created" | "exists" | "failed";
export declare function createSoul(doc: Omit<SoulDocument, "id" | "agent_id" | "created_at" | "updated_at" | "revisions">, store: SurrealStore): Promise<CreateSoulOutcome>;
export type SoulSectionName = "working_style" | "emotional_dimensions" | "self_observations" | "earned_values";
/** Bound on the `revisions` audit trail. Every landed revision appended
 *  forever (`revisions += ...`, no trim anywhere) made the soul row grow
 *  without limit — and getSoul is `SELECT *`, so the whole history rode along
 *  on every wakeup synthesis, evolve fetch/commit, and UI soulView. 50 keeps
 *  a generous forensic window while bounding the row. */
export declare const SOUL_REVISIONS_CAP = 50;
export interface GuardedSoulWrite {
    section: SoulSectionName;
    /** Complete new value for the section — REPLACES it on write. */
    value: unknown[];
    /** The section's value as read in the snapshot this write was computed
     *  from. Used as a value-CAS guard: the UPDATE matches only while the
     *  stored section still equals this. Omit (undefined) to write unguarded —
     *  only for sections that were missing from the snapshot entirely. */
    snapshot?: unknown[];
}
/**
 * Single-shot, value-CAS-guarded multi-section soul revision. Replaces the
 * old per-section reviseSoul(), which had two faults:
 *
 *  - Lost-update race: evolve commits are read(getSoul)→merge→write; two
 *    concurrent drains could interleave and the last writer silently clobbered
 *    the first (per section). The WHERE guard here compares each written
 *    section against the exact value the caller read, so a concurrent write
 *    to any guarded section makes this UPDATE match nothing ("conflict") and
 *    the caller re-reads + re-merges. Guarding on section VALUES (all plain
 *    strings per schema.surql — adopted_at is TYPE string) sidesteps datetime
 *    equality entirely: the SDK returns `updated_at` as a nanosecond DateTime
 *    class (probed 2026-08-16 against the live instance; the old "ISO strings
 *    on the wire" note in SoulDocument predates this SDK), which is exactly
 *    the kind of representation trap a value guard avoids. Probe receipts:
 *    array-of-object equality via binding = true; key-order-insensitive =
 *    true; stale guard → UPDATE returns [].
 *
 *  - Per-section writes: N sections = N UPDATEs, each bumping updated_at and
 *    appending one revision — partial failures left the doc half-revised.
 *    One statement now writes all sections atomically.
 *
 * `revisions += $revs` appends server-side (probed: `+=` with an array
 * operand CONCATENATES), so a concurrent writer's revision entries are never
 * clobbered. The trim to SOUL_REVISIONS_CAP is a separate, lazy,
 * length-guarded UPDATE: it replaces the array only if its length still
 * equals what this write produced — any concurrent append skips the trim
 * (retried on a later revision; the audit trail is the only thing at stake).
 *
 * UPDATE on a missing soul:laqrumbrain is a no-op returning [] (probed), so a
 * soul deleted mid-flight surfaces as "conflict", never a resurrection.
 */
export declare function reviseSoulGuarded(writes: GuardedSoulWrite[], rationale: string, store: SurrealStore, opts?: {
    snapshotRevisions?: unknown[];
}): Promise<"applied" | "conflict" | "error">;
/**
 * Record a graduation_event so session-start surfaces a celebration.
 * Extracted from the former attemptGraduation() — now called by the
 * pending_work soul_generate commit handler.
 */
export declare function recordGraduationEvent(store: SurrealStore, report: GraduationReport): Promise<void>;
/**
 * Format a graduation report for human/LLM consumption.
 * Used by the introspect tool's "status" action.
 */
export declare function formatGraduationReport(report: GraduationReport): string;
/**
 * Seed the soul document as Tier 0 core memory entries.
 * These are loaded every single turn via the existing core memory pipeline.
 *
 * Creates entries for:
 *   - Working style (priority 90)
 *   - Self-observations (priority 85)
 *   - Earned values (priority 88)
 *   - Persona (priority 70) — "you belong in this world"
 */
export declare function seedSoulAsCoreMemory(soul: SoulDocument, store: SurrealStore): Promise<number>;
/**
 * Check and record stage transitions. Returns the new stage if a transition
 * occurred, null otherwise. Persists last-known stage in DB.
 */
export declare function checkStageTransition(store: SurrealStore): Promise<{
    transitioned: boolean;
    previousStage: MaturityStage | null;
    currentStage: MaturityStage;
    report: GraduationReport;
}>;
