/**
 * ACAN — Attentive Cross-Attention Network for learned memory scoring.
 *
 * Replaces the fixed 6-signal WMR weights in scoreResults() with a learned
 * cross-attention model. Ships dormant — auto-trains and activates when
 * enough retrieval outcome data accumulates (5000+ labeled pairs).
 *
 * Ported from kongbrain — uses SurrealStore instead of module-level DB.
 */
import type { SurrealStore } from "./surreal.js";
export interface ACANWeights {
    W_q: number[][];
    W_k: number[][];
    W_final: number[];
    bias: number;
    version: number;
    trainedAt?: number;
    trainedOnSamples?: number;
}
export interface ACANCandidate {
    embedding: number[];
    recency: number;
    importance: number;
    access: number;
    neighborBonus: number;
    provenUtility: number;
    reflectionBoost?: number;
}
export declare function initACAN(weightsDir?: string): boolean;
export declare function isACANActive(): boolean;
export declare function scoreWithACAN(queryEmbedding: number[], candidates: ACANCandidate[]): number[];
export declare function checkACANReadiness(store?: SurrealStore, trainingThreshold?: number, weightsDir?: string): Promise<void>;
