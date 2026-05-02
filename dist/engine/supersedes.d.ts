/**
 * Supersedes — concept evolution tracking.
 *
 * When the daemon extracts a correction (user correcting the assistant),
 * this module finds the concept(s) that contained the stale knowledge
 * and creates `supersedes` edges from the correction memory to those
 * concepts, decaying their stability so they lose priority in recall.
 *
 * Edge direction: correction_memory -> supersedes -> stale_concept
 *
 * This ensures that:
 * 1. Stale knowledge doesn't win over corrections in retrieval
 * 2. The graph records *why* a concept was deprecated
 * 3. Stability decay is proportional to correction confidence
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/**
 * Find concepts AND memories that match the "original" (wrong) statement in
 * a correction, create supersedes edges, and decay their priority in retrieval.
 *
 * 0.7.46+: also targets memory rows. record_finding writes memory rows
 * synchronously while concept extraction is daemon-async. Without memory
 * targeting, supersede was a no-op against beliefs the user/agent had
 * just saved in the same session — silently breaking the documented
 * save→contradict→decay flow. Memories are marked status='superseded'
 * which excludes them from vectorSearch (filter: status='active' OR
 * status IS NONE). Concepts continue to use stability decay.
 *
 * @param correctionMemId - The memory:xxx record ID of the correction
 * @param originalText    - The "original" (incorrect) text from the correction
 * @param correctionText  - The "corrected" (right) text from the correction
 * @param store           - SurrealDB store
 * @param embeddings      - Embedding service
 * @param precomputedVec  - Optional pre-computed embedding of the full correction text
 * @returns               - Combined count of superseded concepts + memories
 */
export declare function linkSupersedesEdges(correctionMemId: string, originalText: string, correctionText: string, store: SurrealStore, embeddings: EmbeddingService, precomputedVec?: number[] | null): Promise<number>;
