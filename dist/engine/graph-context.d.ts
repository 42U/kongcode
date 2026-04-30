/**
 * Graph-based context transformation for KongCode.
 *
 * Core retrieval pipeline: vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. All retrieval logic is identical to KongBrain;
 * only the integration layer (imports, output format) differs.
 */
import type { AgentMessage } from "./types.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SessionState } from "./state.js";
/** Initialize the cross-encoder reranker. Called once at daemon startup
 *  (after EmbeddingService.initialize). Failures degrade gracefully —
 *  retrieval still runs without reranking, just with WMR/ACAN scores. */
export declare function initReranker(modelPath: string): Promise<void>;
export declare function disposeReranker(): Promise<void>;
export declare function isRerankerActive(): boolean;
/** @internal Exported for testing. */
export interface Budgets {
    conversation: number;
    retrieval: number;
    core: number;
    toolHistory: number;
    maxContextItems: number;
}
/** Split the context window into 4 budgets: conversation, retrieval, core memory, and tool history. @internal */
export declare function calcBudgets(contextWindow: number): Budgets;
export interface ContextStats {
    fullHistoryTokens: number;
    sentTokens: number;
    savedTokens: number;
    reductionPct: number;
    graphNodes: number;
    neighborNodes: number;
    recentTurns: number;
    mode: "graph" | "recency-only" | "passthrough";
    prefetchHit: boolean;
}
export declare function formatRelativeTime(ts: string): string;
/** Dot-product cosine similarity between two equal-length vectors. Returns 0 if either has zero magnitude. */
export declare function cosineSimilarity(a: number[], b: number[]): number;
export interface GraphTransformParams {
    messages: AgentMessage[];
    session: SessionState;
    store: SurrealStore;
    embeddings: EmbeddingService;
    contextWindow?: number;
    signal?: AbortSignal;
}
export interface GraphTransformResult {
    messages: AgentMessage[];
    stats: ContextStats;
    /** Static content for the system prompt — benefits from API prefix caching (10% cost). */
    systemPromptSection?: string;
}
/**
 * Main entry point for graph-based context assembly. Retrieves, scores, deduplicates,
 * and budget-trims graph nodes, then splices them into the conversation message array.
 */
export declare function graphTransformContext(params: GraphTransformParams): Promise<GraphTransformResult>;
