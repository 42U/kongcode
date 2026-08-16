/**
 * MCP tools for subagent-driven background processing.
 *
 * fetch_pending_work — Claims the next pending item and returns
 *   instructions + data for the subagent to process.
 * commit_work_results — Accepts the subagent's extraction output
 *   and persists it to SurrealDB via existing write functions.
 *
 * These tools replace the Anthropic SDK direct calls. The LLM
 * reasoning now happens in the subagent (Opus) itself, not in
 * a separate API call from the MCP server.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { type SoulSectionName } from "../engine/soul.js";
import { type SurrealStore } from "../engine/surreal.js";
/**
 * Count pending_work rows that would ACTUALLY yield work if drained — the
 * "actionable" count behind the SessionStart / UserPromptSubmit "DRAIN NOW"
 * banners and the auto-drain spawn decision.
 *
 * The raw `status='pending' AND active` count over-reports: session-end
 * ALWAYS enqueues causal_graduate + soul_evolve/soul_generate regardless of
 * eligibility (session-end.ts), and 4 of 5 builders self-complete to empty
 * when ineligible (see buildWorkPayload below). Counting those raw produced
 * the "DRAIN NOW, N items" banner for a queue that drains to nothing — the
 * recurring empty-drain report (2026-06-18). This runs the SAME global
 * eligibility probes the builders use, so a type is only counted when it
 * would produce a real payload.
 *
 * MUST stay in sync with buildWorkPayload's self-completion conditions.
 * Internal queue-hygiene metrics (observability.ts buildup/aging, the
 * http-api health cache) deliberately keep the RAW count — they measure
 * queue depth / 7-day purge risk, not actionability.
 */
export declare function countActionablePendingWork(store: SurrealStore): Promise<number>;
export declare function handleFetchPendingWork(state: GlobalPluginState, _session: SessionState, _args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
export declare function handleCommitWorkResults(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
export declare function isJunkExtractionText(s: unknown): boolean;
/** working_style / self_observations: stored as string[]. Accept strings and
 *  objects carrying an obvious text field; drop junk and empties. */
declare function coerceStringSection(raw: unknown): string[];
/** emotional_dimensions: stored as {dimension, description, adopted_at}.
 *  Accepts alias keys (name→dimension, rationale→description) and bare
 *  strings (dimension with empty description — mirrors the PR #22
 *  earned_values decision). */
declare function coerceEmotionalDimensions(raw: unknown, now: string): {
    dimension: string;
    description: string;
    adopted_at: string;
}[];
/** earned_values: stored as {value, grounded_in}. Bare strings land as
 *  { value, grounded_in: "" } (PR #22); alias keys per v0.7.65. */
declare function coerceEarnedValues(raw: unknown): {
    value: string;
    grounded_in: string;
}[];
type SoulSection = SoulSectionName;
/**
 * Delta-guard merge for soul_evolve (PR #22 follow-up).
 *
 * reviseSoul REPLACES a section wholesale (`SET ${section} = $newValue`), and
 * the revisions audit trail stores no prior values — a replace that loses
 * entries is silent AND unrecoverable. The evolve prompt now states the
 * contract ("include the complete revised array"), but the drain agent can be
 * Haiku (memory-extractor-lite) and the original PR #22 incident proves
 * agents fall back to delta-thinking. So:
 *
 *   - Submission shares >= 1 key with the stored section → the agent
 *     demonstrably engaged with current content: treat it as a genuine
 *     revision and REPLACE (dropping / rewording entries stays possible).
 *   - Submission has ZERO overlap with a non-empty stored section → the
 *     fingerprint of "only the new entries": APPEND to the stored entries
 *     instead, so a nonconforming agent can add but never destroy.
 *
 * Replace mode also preserves adopted_at on emotional_dimensions whose
 * description didn't change, so echoing an unchanged dimension doesn't
 * destroy its adoption provenance.
 */
declare function mergeSoulSection(section: SoulSection, current: unknown[], submitted: unknown[]): {
    mode: "append" | "replace";
    merged: unknown[];
};
/**
 * Enforce SOUL_SECTION_CAPS on a merged section, mode-aware and never silent:
 *
 *  - replace: the array is the agent's own curated ordering — keep the FIRST
 *    N (matches soul_generate's slice(0, N) convention).
 *  - append: overflow means current + new exceeds the cap — keep the LAST N,
 *    so the oldest entries age out and the new experience lands. Trimming the
 *    new entries instead would re-create the exact silent drop PR #22 fixed.
 *
 * Dropped entries are logged with their identity keys — the daemon log is the
 * forensic trail (same philosophy as the junk-drop logging above).
 */
declare function applySoulSectionCap(section: SoulSection, mode: "append" | "replace", merged: unknown[]): unknown[];
export declare function handleCreateKnowledgeGems(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
interface ExtractedSkill {
    name: string;
    description: string;
    preconditions?: string;
    steps: {
        tool: string;
        description: string;
    }[];
    postconditions?: string;
}
declare function parseSkillResult(results: unknown): ExtractedSkill | null;
declare function parseCausalGraduationResult(results: unknown): ExtractedSkill[];
declare function parseSoulResult(results: unknown): Record<string, any> | null;
export declare const __test__: {
    parseSkillResult: typeof parseSkillResult;
    parseCausalGraduationResult: typeof parseCausalGraduationResult;
    parseSoulResult: typeof parseSoulResult;
    coerceStringSection: typeof coerceStringSection;
    coerceEmotionalDimensions: typeof coerceEmotionalDimensions;
    coerceEarnedValues: typeof coerceEarnedValues;
    mergeSoulSection: typeof mergeSoulSection;
    applySoulSectionCap: typeof applySoulSectionCap;
};
export {};
