/**
 * Shared concept-extraction helpers.
 *
 * Regex-based extraction of concept names from text, plus helpers to
 * upsert extracted concepts and link them via arbitrary edge types.
 */

import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import { swallow } from "./errors.js";

// Same regexes used by the original extractAndLinkConcepts in context-engine.
export const CONCEPT_RE = /\b(?:(?:use|using|implement|create|add|configure|setup|install|import)\s+)([A-Z][a-zA-Z0-9_-]+(?:\s+[A-Z][a-zA-Z0-9_-]+)?)/g;
export const TECH_TERMS = /\b(api|database|schema|migration|endpoint|middleware|component|service|module|handler|controller|model|interface|type|class|function|method|hook|plugin|extension|config|cache|queue|worker|daemon)\b/gi;

/** Extract concept name strings from free text using regex heuristics. */
export function extractConceptNames(text: string): string[] {
  const concepts = new Set<string>();

  let match: RegExpExecArray | null;
  const re1 = new RegExp(CONCEPT_RE.source, CONCEPT_RE.flags);
  while ((match = re1.exec(text)) !== null) {
    concepts.add(match[1].trim());
  }

  const re2 = new RegExp(TECH_TERMS.source, TECH_TERMS.flags);
  while ((match = re2.exec(text)) !== null) {
    concepts.add(match[1].toLowerCase());
  }

  return [...concepts].slice(0, 10);
}

/**
 * Upsert concepts from text and link them to a source node via the given edge.
 *
 * Used for:
 *  - turn  → "mentions"          → concept  (existing behaviour)
 *  - memory → "about_concept"    → concept  (Fix 1)
 *  - artifact → "artifact_mentions" → concept (Fix 2)
 */
export async function upsertAndLinkConcepts(
  sourceId: string,
  edgeName: string,
  text: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
  opts?: { taskId?: string; projectId?: string },
): Promise<void> {
  const names = extractConceptNames(text);
  if (names.length === 0) return;

  for (const name of names) {
    try {
      let embedding: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { embedding = await embeddings.embed(name); } catch { /* ok */ }
      }
      const conceptId = await store.upsertConcept(name, embedding, logTag);
      if (conceptId) {
        await store.relate(sourceId, edgeName, conceptId)
          .catch(e => swallow(`${logTag}:relate`, e));

        // derived_from: concept → task
        if (opts?.taskId) {
          await store.relate(conceptId, "derived_from", opts.taskId)
            .catch(e => swallow(`${logTag}:derived_from`, e));
        }
        // relevant_to: concept → project
        if (opts?.projectId) {
          await store.relate(conceptId, "relevant_to", opts.projectId)
            .catch(e => swallow(`${logTag}:relevant_to`, e));
        }
      }
    } catch (e) {
      swallow(`${logTag}:upsert`, e);
    }
  }
}

/**
 * Embedding-based concept linking — replaces batch-local linkToConcepts.
 *
 * Given a source node (memory, artifact, turn, skill) and its text content,
 * embeds the text and finds the top-N most similar concepts in the graph,
 * then creates edges from source → concept via the specified relation.
 *
 * This ensures linking works even when relevant concepts were created in
 * prior batches or sessions — no batch-timing dependency.
 */
export async function linkToRelevantConcepts(
  sourceId: string,
  edgeName: string,
  text: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
  limit = 5,
  threshold = 0.65,
  precomputedVec?: number[] | null,
): Promise<void> {
  if (!embeddings.isAvailable() || !text) return;
  try {
    const vec = precomputedVec?.length ? precomputedVec : await embeddings.embed(text);
    if (!vec?.length) return;
    const matches = await store.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC
       LIMIT $lim`,
      { vec, lim: limit },
    );
    for (const m of matches) {
      if (m.score < threshold) break;
      await store.relate(sourceId, edgeName, String(m.id))
        .catch(e => swallow(`${logTag}:relate`, e));
    }
  } catch (e) {
    swallow(`${logTag}:embed`, e);
  }
}

/**
 * Link a newly-upserted concept to existing concepts via narrower/broader
 * edges when one concept's name is a substring of the other (indicating a
 * parent-child hierarchy, e.g. "React" → "React hooks").
 */
export async function linkConceptHierarchy(
  conceptId: string,
  conceptName: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
): Promise<void> {
  try {
    const existing = await store.queryFirst<{ id: string; content: string }>(
      `SELECT id, content FROM concept WHERE id != $cid LIMIT 50`,
      { cid: conceptId },
    );
    if (existing.length === 0) return;

    const lowerName = conceptName.toLowerCase();
    let relatedCount = 0;

    for (const other of existing) {
      const otherLower = (other.content ?? "").toLowerCase();
      if (!otherLower || otherLower === lowerName) continue;

      const otherId = String(other.id);

      if (lowerName.includes(otherLower) && lowerName !== otherLower) {
        // New concept is more specific (e.g. "React hooks" contains "React")
        await store.relate(conceptId, "narrower", otherId)
          .catch(e => swallow(`${logTag}:narrower`, e));
        await store.relate(otherId, "broader", conceptId)
          .catch(e => swallow(`${logTag}:broader`, e));
      } else if (otherLower.includes(lowerName) && otherLower !== lowerName) {
        // New concept is more general (e.g. "React" contained in "React hooks")
        await store.relate(conceptId, "broader", otherId)
          .catch(e => swallow(`${logTag}:broader`, e));
        await store.relate(otherId, "narrower", conceptId)
          .catch(e => swallow(`${logTag}:narrower`, e));
      }
    }

    // related_to: peer-level semantic association via embedding similarity
    if (embeddings.isAvailable()) {
      try {
        const conceptEmb = await embeddings.embed(conceptName);
        if (conceptEmb?.length) {
          const similar = await store.queryFirst<{ id: string; score: number }>(
            `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
             FROM concept
             WHERE id != $cid
               AND embedding != NONE AND array::len(embedding) > 0
             ORDER BY score DESC
             LIMIT 3`,
            { vec: conceptEmb, cid: conceptId },
          );
          for (const s of similar) {
            if (s.score < 0.75) break;
            const simId = String(s.id);
            await store.relate(conceptId, "related_to", simId)
              .catch(e => swallow(`${logTag}:related_to`, e));
            await store.relate(simId, "related_to", conceptId)
              .catch(e => swallow(`${logTag}:related_to`, e));
          }
        }
      } catch (e) {
        swallow(`${logTag}:related_to_search`, e);
      }
    }
  } catch (e) {
    swallow(`${logTag}:hierarchy`, e);
  }
}
