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
 * Find concepts that match the "original" (wrong) statement in a correction,
 * create supersedes edges, and decay their stability.
 *
 * @param correctionMemId - The memory:xxx record ID of the correction
 * @param originalText    - The "original" (incorrect) text from the correction
 * @param correctionText  - The "corrected" (right) text from the correction
 * @param store           - SurrealDB store
 * @param embeddings      - Embedding service
 * @param precomputedVec  - Optional pre-computed embedding of the full correction text
 */
export declare function linkSupersedesEdges(correctionMemId: string, originalText: string, correctionText: string, store: SurrealStore, embeddings: EmbeddingService, precomputedVec?: number[] | null): Promise<number>;
