/**
 * Causal Memory Graph
 *
 * Activates the dormant caused_by/supports/contradicts edges in the graph.
 * At session end, analyzes the conversation for cause-effect sequences
 * (bug->investigation->fix->outcome) and creates causal chains linking memories.
 * During retrieval, traverses causal edges to pull full chains as context.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore, VectorSearchResult } from "./surreal.js";
import { swallow } from "./errors.js";
import { assertRecordId } from "./surreal.js";

// --- Types ---

export interface CausalChain {
  triggerText: string;
  outcomeText: string;
  chainType: "debug" | "refactor" | "feature" | "fix";
  success: boolean;
  confidence: number;
  description: string;
}

/**
 * Create memory nodes for each end of the chain and link them with
 * caused_by/supports/contradicts edges.
 */
export async function linkCausalEdges(
  chains: CausalChain[],
  sessionId: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
): Promise<void> {
  if (chains.length === 0 || !store.isAvailable()) return;

  for (const chain of chains) {
    try {
      // Create trigger memory
      let triggerEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { triggerEmb = await embeddings.embed(chain.triggerText); } catch (e) { swallow("causal:ok", e); }
      }
      const triggerId = await store.createMemory(
        chain.triggerText, triggerEmb, 5, `causal_trigger_${chain.chainType}`, sessionId,
      );

      // Create outcome memory
      let outcomeEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { outcomeEmb = await embeddings.embed(chain.outcomeText); } catch (e) { swallow("causal:ok", e); }
      }
      const outcomeId = await store.createMemory(
        chain.outcomeText, outcomeEmb, 6, `causal_outcome_${chain.chainType}`, sessionId,
      );

      if (!triggerId || !outcomeId) continue;

      // Create causal edges
      await store.relate(outcomeId, "caused_by", triggerId).catch(e => swallow.warn("causal:relateCausedBy", e));
      if (chain.success) {
        await store.relate(outcomeId, "supports", triggerId).catch(e => swallow.warn("causal:relateSupports", e));
      } else {
        await store.relate(outcomeId, "contradicts", triggerId).catch(e => swallow.warn("causal:relateContradicts", e));
      }

      // Embed the description as a searchable memory node
      let descriptionId: string | null = null;
      if (chain.description && chain.description.length > 10) {
        const descText = `[${chain.chainType}${chain.success ? "" : " FAILED"}] ${chain.description}`;
        let descEmb: number[] | null = null;
        if (embeddings.isAvailable()) {
          try { descEmb = await embeddings.embed(descText); } catch (e) { swallow("causal:ok", e); }
        }
        descriptionId = await store.createMemory(
          descText, descEmb, 5, `causal_description_${chain.chainType}`, sessionId,
        );
        if (descriptionId) {
          await store.relate(descriptionId, "describes", triggerId).catch(e => swallow.warn("causal:relateDescTrigger", e));
          await store.relate(descriptionId, "describes", outcomeId).catch(e => swallow.warn("causal:relateDescOutcome", e));
        }
      }

      // Store chain metadata
      await store.queryExec(`CREATE causal_chain CONTENT $data`, {
        data: {
          session_id: String(sessionId),
          trigger_memory: triggerId,
          outcome_memory: outcomeId,
          description_memory: descriptionId,
          chain_type: chain.chainType,
          success: chain.success,
          confidence: chain.confidence,
          description: chain.description,
        },
      }).catch(e => swallow.warn("causal:storeChain", e));
    } catch (e) {
      swallow("causal:silent", e);
    }
  }
}

// --- Causal Context Retrieval ---

/**
 * Given seed memory IDs from vector search, traverse causal edges
 * (caused_by, supports, contradicts) up to `hops` deep.
 * Computes cosine similarity server-side so results compete fairly in scoring.
 */
export async function queryCausalContext(
  seedIds: string[],
  queryVec: number[],
  hops = 2,
  minConfidence = 0.4,
  store?: SurrealStore,
): Promise<VectorSearchResult[]> {
  if (seedIds.length === 0 || !store?.isAvailable()) return [];

  const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_]+$/;
  const validIds = seedIds.filter((id) => RECORD_ID_RE.test(id)).slice(0, 10);
  if (validIds.length === 0) return [];

  const causalEdges = ["caused_by", "supports", "contradicts", "describes"];
  const seen = new Set<string>(validIds);
  let frontier = validIds;
  const results: VectorSearchResult[] = [];
  const bindings = { vec: queryVec };

  const scoreExpr = `, IF embedding != NONE AND array::len(embedding) > 0
         THEN vector::similarity::cosine(embedding, $vec)
         ELSE 0 END AS score`;

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    // Batch all edge traversals for this hop in a single round-trip
    const selectFields = `SELECT id, text, importance, access_count AS accessCount,
                  created_at AS timestamp, category, meta::tb(id) AS table${scoreExpr}`;
    const stmts: string[] = [];
    for (const id of frontier) {
      assertRecordId(id);
      for (const edge of causalEdges) {
        if (!/^[a-z_]+$/.test(edge)) continue; // safety check
        stmts.push(`${selectFields} FROM ${id}->${edge}->? LIMIT 3`);
        stmts.push(`${selectFields} FROM ${id}<-${edge}<-? LIMIT 3`);
      }
    }

    let allQueryResults: any[][];
    try {
      allQueryResults = await store.queryBatch<any>(stmts, bindings);
    } catch (e) {
      swallow.warn("causal:batch", e);
      break;
    }
    const nextFrontier: string[] = [];

    for (const rows of allQueryResults) {
      for (const row of rows) {
        const nodeId = String(row.id);
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);

        const text = row.text ?? "";
        if (text) {
          results.push({
            id: nodeId,
            text,
            score: row.score ?? 0,
            importance: row.importance,
            accessCount: row.accessCount,
            timestamp: row.timestamp,
            table: String(row.table ?? "memory"),
            source: row.category,
          });
          if (RECORD_ID_RE.test(nodeId)) {
            nextFrontier.push(nodeId);
          }
        }
      }
    }

    frontier = nextFrontier.slice(0, 5);
  }

  // Filter by causal_chain confidence
  if (results.length > 0 && minConfidence > 0) {
    const resultIds = results.map(r => r.id);
    try {
      const chains = await store.queryFirst<{ trigger_memory: string; outcome_memory: string; confidence: number }>(
        `SELECT trigger_memory, outcome_memory, confidence FROM causal_chain
         WHERE confidence >= $minConf AND (trigger_memory IN $ids OR outcome_memory IN $ids)`,
        { minConf: minConfidence, ids: resultIds },
      );
      const allowedIds = new Set<string>();
      for (const c of chains) {
        allowedIds.add(String(c.trigger_memory));
        allowedIds.add(String(c.outcome_memory));
      }
      return results.filter(r => allowedIds.has(r.id));
    } catch (e) {
      swallow.warn("causal:confidence-filter", e);
      return results;
    }
  }

  return results;
}

/**
 * Get causal chain metadata for a session (for metrics/display).
 */
export async function getSessionCausalChains(
  sessionId: string,
  store: SurrealStore,
): Promise<{ count: number; successRate: number }> {
  try {
    if (!store.isAvailable()) return { count: 0, successRate: 0 };
    const rows = await store.queryFirst<{ total: number; successes: number }>(
      `SELECT count() AS total, math::sum(IF success THEN 1 ELSE 0 END) AS successes
       FROM causal_chain WHERE session_id = $sid GROUP ALL`,
      { sid: sessionId },
    );
    const row = rows[0];
    if (!row || !row.total) return { count: 0, successRate: 0 };
    return {
      count: Number(row.total),
      successRate: Number(row.successes) / Number(row.total),
    };
  } catch (e) {
    swallow("causal:metrics", e);
    return { count: 0, successRate: 0 };
  }
}
