/**
 * Concept linking — pure edge-wiring helpers.
 *
 * Extracted from concept-extract.ts in 0.4.0 so that commit.ts can compose
 * these helpers without creating a circular import: commit.ts wants to
 * fire hierarchy + related_to links inside commitKnowledge, while
 * concept-extract.ts's upsertAndLinkConcepts wants to route through
 * commitKnowledge. Shared state-writer helpers living in their own module
 * lets both arrows point inward to this leaf file and nothing points back.
 */
import { swallow } from "./errors.js";
/**
 * Embedding-based concept linking.
 *
 * Given a source node (memory, artifact, turn, skill) and its text content,
 * embeds the text and finds the top-N most similar concepts in the graph,
 * then creates edges from source → concept via the specified relation.
 *
 * This ensures linking works even when relevant concepts were created in
 * prior batches or sessions — no batch-timing dependency.
 */
export async function linkToRelevantConcepts(sourceId, edgeName, text, store, embeddings, logTag, limit = 5, threshold = 0.65, precomputedVec) {
    if (!embeddings.isAvailable() || !text)
        return;
    try {
        const vec = precomputedVec?.length ? precomputedVec : await embeddings.embed(text);
        if (!vec?.length)
            return;
        const matches = await store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC
       LIMIT $lim`, { vec, lim: limit });
        for (const m of matches) {
            if (m.score < threshold)
                break;
            await store.relate(sourceId, edgeName, String(m.id))
                .catch(e => swallow(`${logTag}:relate`, e));
        }
    }
    catch (e) {
        swallow(`${logTag}:embed`, e);
    }
}
/**
 * Link a newly-upserted concept to existing concepts via narrower/broader
 * edges when one concept's name is a substring of the other (indicating a
 * parent-child hierarchy, e.g. "React" → "React hooks"), plus related_to
 * edges for peer-level semantic associations.
 */
export async function linkConceptHierarchy(conceptId, conceptName, store, embeddings, logTag) {
    try {
        const existing = await store.queryFirst(`SELECT id, content FROM concept WHERE id != $cid LIMIT 50`, { cid: conceptId });
        if (existing.length === 0)
            return;
        const lowerName = conceptName.toLowerCase();
        for (const other of existing) {
            const otherLower = (other.content ?? "").toLowerCase();
            if (!otherLower || otherLower === lowerName)
                continue;
            const otherId = String(other.id);
            if (lowerName.includes(otherLower) && lowerName !== otherLower) {
                // New concept is more specific (e.g. "React hooks" contains "React")
                await store.relate(conceptId, "narrower", otherId)
                    .catch(e => swallow.warn(`${logTag}:narrower`, e));
                await store.relate(otherId, "broader", conceptId)
                    .catch(e => swallow.warn(`${logTag}:broader`, e));
            }
            else if (otherLower.includes(lowerName) && otherLower !== lowerName) {
                // New concept is more general (e.g. "React" contained in "React hooks")
                await store.relate(conceptId, "broader", otherId)
                    .catch(e => swallow.warn(`${logTag}:broader`, e));
                await store.relate(otherId, "narrower", conceptId)
                    .catch(e => swallow.warn(`${logTag}:narrower`, e));
            }
        }
        // related_to: peer-level semantic association via embedding similarity
        if (embeddings.isAvailable()) {
            try {
                const conceptEmb = await embeddings.embed(conceptName);
                if (conceptEmb?.length) {
                    const similar = await store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
             FROM concept
             WHERE id != $cid
               AND embedding != NONE AND array::len(embedding) > 0
             ORDER BY score DESC
             LIMIT 3`, { vec: conceptEmb, cid: conceptId });
                    for (const s of similar) {
                        if (s.score < 0.75)
                            break;
                        const simId = String(s.id);
                        await store.relate(conceptId, "related_to", simId)
                            .catch(e => swallow.warn(`${logTag}:related_to`, e));
                        await store.relate(simId, "related_to", conceptId)
                            .catch(e => swallow.warn(`${logTag}:related_to`, e));
                    }
                }
            }
            catch (e) {
                swallow(`${logTag}:related_to_search`, e);
            }
        }
    }
    catch (e) {
        swallow(`${logTag}:hierarchy`, e);
    }
}
