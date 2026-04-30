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
import { swallow } from "./errors.js";
// Per-turn state — module-level since only one turn is active at a time.
// 0.7.27: indexMap holds the [#N] → memory_id map built at injection time
// so Stop can parse the assistant response for [#1], [#2], etc. and write
// `cited=true` to matching retrieval_outcome rows.
let _pendingRetrieval = null;
export function getStagedItems() {
    return _pendingRetrieval?.items ? [..._pendingRetrieval.items] : [];
}
export function stageRetrieval(sessionId, items, queryEmbedding, indexMap) {
    _pendingRetrieval = {
        sessionId,
        items,
        toolResults: [],
        queryEmbedding,
        indexMap,
    };
}
export function recordToolOutcome(success) {
    if (_pendingRetrieval) {
        _pendingRetrieval.toolResults.push({ success });
    }
}
/**
 * Evaluate retrieval quality after assistant response.
 */
export async function evaluateRetrieval(responseTurnId, responseText, store) {
    if (!_pendingRetrieval || _pendingRetrieval.items.length === 0) {
        _pendingRetrieval = null;
        return;
    }
    const { sessionId, items, toolResults, queryEmbedding, indexMap } = _pendingRetrieval;
    _pendingRetrieval = null;
    // Use majority-based success: mark as successful if >= 50% of tool calls
    // succeeded. The previous `every()` logic caused 99%+ failure rates because
    // a single exploratory failure (e.g. file-not-found) would tank the whole turn.
    const toolSuccess = toolResults.length > 0
        ? toolResults.filter((r) => r.success).length / toolResults.length >= 0.5
        : null;
    const responseLower = responseText.toLowerCase();
    // 0.7.27: parse [#N] citations from the response. Build a set of cited
    // memory_ids by intersecting parsed indexes with the indexMap built at
    // injection time. This is the structural-citation signal — distinct from
    // (and stronger than) the lexical utilization signal computed below.
    const citedIds = new Set();
    if (indexMap) {
        const matches = responseText.matchAll(/\[#(\d+)\]/g);
        for (const m of matches) {
            const idx = parseInt(m[1], 10);
            const id = indexMap.get(idx);
            if (id)
                citedIds.add(id);
        }
    }
    for (const item of items) {
        const signals = computeSignals(item, responseLower, toolSuccess);
        const idStr = String(item.id);
        const wasCited = citedIds.has(idStr);
        try {
            const record = {
                session_id: sessionId,
                turn_id: responseTurnId,
                memory_id: idStr,
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
            // 0.7.27: structural-citation signal. cited=true means the model
            // explicitly emitted [#N] referencing this item; cited=false means it
            // was offered but ignored. Distinct from the lexical utilization
            // overlap. citation_method='index' for [#N], 'lexical' for content
            // matches when no [#N] hit landed (future), 'none' otherwise.
            if (indexMap) {
                record.cited = wasCited;
                record.citation_method = wasCited ? "index" : "none";
            }
            await store.queryExec(`CREATE retrieval_outcome CONTENT $data`, { data: record });
            store.updateUtilityCache(idStr, signals.utilization)
                .catch(e => swallow.warn("retrieval-quality:utilityCache", e));
        }
        catch {
            // non-critical telemetry
        }
    }
}
/** 0.7.27: count how many high-salience items the assistant ignored last
 *  turn. Used by cognitive-check to inject a Reflexion-style nudge. */
export async function getLastTurnGroundingTrace(sessionId, store) {
    try {
        const rows = await store.queryFirst(`SELECT memory_id, retrieval_score, cited FROM retrieval_outcome
       WHERE session_id = $sid AND turn_id IN (
         SELECT turn_id FROM retrieval_outcome
         WHERE session_id = $sid
         GROUP BY turn_id ORDER BY MAX(created_at) DESC LIMIT 1
       )`, { sid: sessionId });
        if (rows.length === 0)
            return null;
        const cited = rows.filter((r) => r.cited === true).length;
        const ignored = rows
            .filter((r) => r.cited !== true && (r.retrieval_score ?? 0) >= 0.6)
            .map((r) => String(r.memory_id));
        return { injected: rows.length, cited, ignored_high_salience: ignored };
    }
    catch {
        return null;
    }
}
// --- Signal computation ---
export function computeSignals(item, responseLower, toolSuccess) {
    const rawText = item.text ?? "";
    const memText = rawText.toLowerCase();
    const contextTokens = Math.ceil(rawText.length / 4);
    // Lexical signals: specific-term reuse (high signal) + topical word overlap
    // (low signal). Previously `Math.max(..., unigram * 0.5)` was the whole
    // story, which gave a hard ceiling at the strongest single signal and
    // halved unigram before it could compete — pinning utilization at ~10%
    // graph-wide. Now: a weighted blend so partial-but-broad overlap counts,
    // and a small bonus when retrieval was followed by successful tool use
    // (tool_success was already computed but never folded into utilization).
    const keyTermScore = keyTermOverlap(rawText, responseLower);
    const trigramScore = trigramOverlap(memText, responseLower);
    const unigramScore = unigramOverlap(memText, responseLower);
    const specific = Math.max(keyTermScore, trigramScore);
    const lexical = 0.6 * specific + 0.4 * unigramScore;
    const toolBoost = toolSuccess === true ? 0.2 : 0;
    const utilization = Math.min(1, lexical + toolBoost);
    let recency = 0.5;
    if (item.timestamp) {
        const ageHours = (Date.now() - new Date(item.timestamp).getTime()) / 3_600_000;
        recency = Math.exp(-ageHours / 168);
    }
    return { utilization, toolSuccess, contextTokens, wasNeighbor: item.fromNeighbor ?? false, recency };
}
function stripPunctuation(text) {
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
function extractKeyTerms(text) {
    const terms = new Set();
    for (const pattern of KEY_TERM_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const term = match[1].trim().toLowerCase();
            if (term.length >= 3 && !STOP_WORDS.has(term))
                terms.add(term);
        }
    }
    return terms;
}
function keyTermOverlap(source, targetLower) {
    const terms = extractKeyTerms(source);
    if (terms.size === 0)
        return 0;
    const cleanTarget = stripPunctuation(targetLower);
    let found = 0;
    for (const term of terms) {
        if (cleanTarget.includes(term))
            found++;
    }
    return found / terms.size;
}
function trigramOverlap(source, target) {
    const srcGrams = extractNgrams(stripPunctuation(source));
    if (srcGrams.size === 0)
        return 0;
    const tgtGrams = extractNgrams(stripPunctuation(target));
    let matches = 0;
    for (const gram of srcGrams) {
        if (tgtGrams.has(gram))
            matches++;
    }
    return matches / srcGrams.size;
}
function extractNgrams(text) {
    const words = text.split(/\s+/).filter((w) => w.length > 2);
    const grams = new Set();
    if (words.length >= 3) {
        for (let i = 0; i <= words.length - 3; i++) {
            grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
        }
    }
    else if (words.length === 2) {
        grams.add(`${words[0]} ${words[1]}`);
    }
    else if (words.length === 1) {
        grams.add(words[0]);
    }
    return grams;
}
function unigramOverlap(source, target) {
    const srcWords = new Set(stripPunctuation(source).split(/\s+/)
        .filter((w) => w.length >= 5 && !STOP_WORDS.has(w)));
    if (srcWords.size === 0)
        return 0;
    const cleanTarget = " " + stripPunctuation(target) + " ";
    let found = 0;
    for (const word of srcWords) {
        if (cleanTarget.includes(` ${word} `) || cleanTarget.includes(` ${word}s `))
            found++;
    }
    return found / srcWords.size;
}
// --- Historical utility queries ---
export async function getHistoricalUtilityBatch(ids, store) {
    const result = new Map();
    if (ids.length === 0 || !store)
        return result;
    try {
        const flat = await store.queryFirst(`SELECT memory_id,
        math::mean(IF llm_relevance != NONE THEN llm_relevance ELSE utilization END) AS avg
       FROM retrieval_outcome
       WHERE memory_id IN $ids AND (utilization > 0 OR llm_relevance != NONE)
       GROUP BY memory_id`, { ids });
        for (const row of flat) {
            if (row.avg != null)
                result.set(String(row.memory_id), row.avg);
        }
    }
    catch (e) {
        swallow("retrieval-quality:batch", e);
    }
    return result;
}
export async function getRecentUtilizationAvg(sessionId, windowSize = 10, store) {
    if (!store)
        return null;
    try {
        const rows = await store.queryFirst(`SELECT math::mean(utilization) AS avg FROM (SELECT utilization, created_at FROM retrieval_outcome WHERE session_id = $sid ORDER BY created_at DESC LIMIT $lim)`, { sid: sessionId, lim: windowSize });
        return rows[0]?.avg ?? null;
    }
    catch {
        return null;
    }
}
