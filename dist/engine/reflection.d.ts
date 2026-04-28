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
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore } from "./surreal.js";
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
export declare function setReflectionContextWindow(cw: number): void;
/**
 * Gather session metrics and determine if reflection is warranted.
 */
export declare function gatherSessionMetrics(sessionId: string, store: SurrealStore): Promise<ReflectionMetrics | null>;
/**
 * Determine if session performance warrants a reflection.
 */
export declare function shouldReflect(metrics: ReflectionMetrics): {
    reflect: boolean;
    reasons: string[];
};
/**
 * Generate a structured reflection from session performance data.
 * Only called when shouldReflect() returns true.
 */
export declare function generateReflection(sessionId: string, store: SurrealStore, embeddings: EmbeddingService, surrealSessionId?: string): Promise<void>;
/**
 * Vector search on the reflection table.
 */
export declare function retrieveReflections(queryVec: number[], limit?: number, store?: SurrealStore): Promise<Reflection[]>;
/**
 * Format reflections as a context block for the LLM.
 */
export declare function formatReflectionContext(reflections: Reflection[]): string;
/**
 * Get reflection count (for /stats display).
 */
export declare function getReflectionCount(store: SurrealStore): Promise<number>;
