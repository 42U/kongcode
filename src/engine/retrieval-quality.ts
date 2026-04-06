/**
 * Retrieval Quality Tracker
 *
 * Measures whether retrieved context was actually useful, not just relevant.
 * Tracks 6 signals from research:
 * 1. Referenced in response (text overlap)
 * 2. Task success (tool executions)
 * 3. Retrieval stability
 * 4. Access patterns
 * 5. Context waste
 * 6. Contradiction detection
 *
 * Ported from kongbrain — uses SurrealStore instead of module-level DB.
 */

import type { SurrealStore, VectorSearchResult } from "./surreal.js";
import { swallow } from "./errors.js";

export type RetrievedItem = VectorSearchResult & {
  finalScore?: number;
  fromNeighbor?: boolean;
};

interface QualitySignals {
  utilization: number;
  toolSuccess: boolean | null;
  contextTokens: number;
  wasNeighbor: boolean;
  recency: number;
}

// Per-turn state — module-level since only one turn is active at a time
let _pendingRetrieval: {
  sessionId: string;
  items: RetrievedItem[];
  toolResults: { success: boolean }[];
  queryEmbedding?: number[];
} | null = null;

export function getStagedItems(): RetrievedItem[] {
  return _pendingRetrieval?.items ? [..._pendingRetrieval.items] : [];
}

export function stageRetrieval(
  sessionId: string,
  items: RetrievedItem[],
  queryEmbedding?: number[],
): void {
  _pendingRetrieval = {
    sessionId,
    items,
    toolResults: [],
    queryEmbedding,
  };
}

export function recordToolOutcome(success: boolean): void {
  if (_pendingRetrieval) {
    _pendingRetrieval.toolResults.push({ success });
  }
}

/**
 * Evaluate retrieval quality after assistant response.
 */
export async function evaluateRetrieval(
  responseTurnId: string,
  responseText: string,
  store: SurrealStore,
): Promise<void> {
  if (!_pendingRetrieval || _pendingRetrieval.items.length === 0) {
    _pendingRetrieval = null;
    return;
  }

  const { sessionId, items, toolResults, queryEmbedding } = _pendingRetrieval;
  _pendingRetrieval = null;

  const toolSuccess = toolResults.length > 0
    ? toolResults.every((r) => r.success)
    : null;

  const responseLower = responseText.toLowerCase();

  for (const item of items) {
    const signals = computeSignals(item, responseLower, toolSuccess);

    try {
      const record: Record<string, unknown> = {
        session_id: sessionId,
        turn_id: responseTurnId,
        memory_id: String(item.id),
        memory_table: item.table,
        retrieval_score: item.finalScore ?? 0,
        utilization: signals.utilization,
        context_tokens: signals.contextTokens,
        was_neighbor: signals.wasNeighbor,
        importance: ((item.importance ?? 5) / 10),
        access_count: Math.min((item.accessCount ?? 0) / 50, 1),
        recency: signals.recency,
      };
      if (signals.toolSuccess != null) {
        record.tool_success = signals.toolSuccess;
      }
      if (queryEmbedding) {
        record.query_embedding = queryEmbedding;
      }
      await store.queryExec(`CREATE retrieval_outcome CONTENT $data`, { data: record });
      store.updateUtilityCache(String(item.id), signals.utilization)
        .catch(e => swallow.warn("retrieval-quality:utilityCache", e));
    } catch {
      // non-critical telemetry
    }
  }
}

// --- Signal computation ---

function computeSignals(
  item: RetrievedItem,
  responseLower: string,
  toolSuccess: boolean | null,
): QualitySignals {
  const rawText = item.text ?? "";
  const memText = rawText.toLowerCase();
  const contextTokens = Math.ceil(rawText.length / 4);

  const keyTermScore = keyTermOverlap(rawText, responseLower);
  const trigramScore = trigramOverlap(memText, responseLower);
  const unigramScore = unigramOverlap(memText, responseLower);
  const utilization = Math.max(keyTermScore, trigramScore, unigramScore * 0.5);

  let recency = 0.5;
  if (item.timestamp) {
    const ageHours = (Date.now() - new Date(item.timestamp).getTime()) / 3_600_000;
    recency = Math.exp(-ageHours / 168);
  }

  return { utilization, toolSuccess, contextTokens, wasNeighbor: item.fromNeighbor ?? false, recency };
}

function stripPunctuation(text: string): string {
  return text.replace(/[.,;:!?()"'\[\]{}<>—–…]/g, " ");
}

const KEY_TERM_PATTERNS = [
  /`([^`]{2,60})`/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
  /\b([A-Z]{2,}(?:[-_][A-Z0-9]+)*)\b/g,
  /\b([A-Z][a-z]*[A-Z]\w*)\b/g,
  /\b([A-Z][a-z]{2,})\b/g,
  /\b(\w+(?:[-_]\w+){1,3})\b/g,
];

const STOP_WORDS = new Set([
  "the", "a", "an", "but", "and", "or", "if", "when", "this", "that",
  "for", "with", "from", "into", "not", "are", "was", "were", "has",
  "have", "been", "its", "can", "will", "may", "also", "just", "then",
  "than", "too", "very", "such", "each", "all", "any", "most", "more",
  "some", "other", "about", "over", "only", "new", "used", "how", "where",
  "what", "which", "who", "whom", "does", "did", "had", "could", "would",
  "should", "shall", "let", "get", "got", "set", "put", "run", "see",
  "try", "use", "one", "two", "now", "way", "own", "same", "here",
  "there", "still", "yet", "both", "few", "many", "much", "well",
]);

function extractKeyTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const pattern of KEY_TERM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const term = match[1].trim().toLowerCase();
      if (term.length >= 3 && !STOP_WORDS.has(term)) terms.add(term);
    }
  }
  return terms;
}

function keyTermOverlap(source: string, targetLower: string): number {
  const terms = extractKeyTerms(source);
  if (terms.size === 0) return 0;
  const cleanTarget = stripPunctuation(targetLower);
  let found = 0;
  for (const term of terms) { if (cleanTarget.includes(term)) found++; }
  return found / terms.size;
}

function trigramOverlap(source: string, target: string): number {
  const srcGrams = extractNgrams(stripPunctuation(source));
  if (srcGrams.size === 0) return 0;
  const tgtGrams = extractNgrams(stripPunctuation(target));
  let matches = 0;
  for (const gram of srcGrams) { if (tgtGrams.has(gram)) matches++; }
  return matches / srcGrams.size;
}

function extractNgrams(text: string): Set<string> {
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  const grams = new Set<string>();
  if (words.length >= 3) {
    for (let i = 0; i <= words.length - 3; i++) {
      grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  } else if (words.length === 2) {
    grams.add(`${words[0]} ${words[1]}`);
  } else if (words.length === 1) {
    grams.add(words[0]);
  }
  return grams;
}

function unigramOverlap(source: string, target: string): number {
  const srcWords = new Set(
    stripPunctuation(source).split(/\s+/)
      .filter((w) => w.length >= 5 && !STOP_WORDS.has(w)),
  );
  if (srcWords.size === 0) return 0;
  const cleanTarget = " " + stripPunctuation(target) + " ";
  let found = 0;
  for (const word of srcWords) {
    if (cleanTarget.includes(` ${word} `) || cleanTarget.includes(` ${word}s `)) found++;
  }
  return found / srcWords.size;
}

// --- Historical utility queries ---

export async function getHistoricalUtilityBatch(
  ids: string[],
  store?: SurrealStore,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (ids.length === 0 || !store) return result;
  try {
    const flat = await store.queryFirst<{ memory_id: string; avg: number }>(
      `SELECT memory_id,
        math::mean(IF llm_relevance != NONE THEN llm_relevance ELSE utilization END) AS avg
       FROM retrieval_outcome
       WHERE memory_id IN $ids AND (utilization > 0 OR llm_relevance != NONE)
       GROUP BY memory_id`,
      { ids },
    );
    for (const row of flat) {
      if (row.avg != null) result.set(String(row.memory_id), row.avg);
    }
  } catch (e) {
    swallow("retrieval-quality:batch", e);
  }
  return result;
}

export async function getRecentUtilizationAvg(
  sessionId: string,
  windowSize = 10,
  store?: SurrealStore,
): Promise<number | null> {
  if (!store) return null;
  try {
    const rows = await store.queryFirst<{ avg: number }>(
      `SELECT math::mean(utilization) AS avg FROM (SELECT utilization, created_at FROM retrieval_outcome WHERE session_id = $sid ORDER BY created_at DESC LIMIT $lim)`,
      { sid: sessionId, lim: windowSize },
    );
    return rows[0]?.avg ?? null;
  } catch {
    return null;
  }
}
