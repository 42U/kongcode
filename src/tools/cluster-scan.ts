/**
 * cluster_scan MCP tool — recall with grouped output.
 *
 * Plain recall returns a flat score-sorted list. For questions like "what do
 * I know about X?", a cluster view is more useful than a ranked list:
 *   - Groups results by their shared concept neighbors (if any)
 *   - Labels each cluster by the concepts all members reference
 *   - Surfaces singleton results separately
 *
 * The substrate shape (turns → mentions → concepts ← about_concept ← memories)
 * already makes clustering cheap: two result nodes share a cluster if they
 * overlap significantly on the concept neighbors the graph returned.
 *
 * Wraps the existing vectorSearch primitive; does no new retrieval, just
 * re-shapes the output.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { swallow } from "../engine/errors.js";

interface ResultItem {
  id: string;
  text: string;
  table: string;
  score: number;
  neighbors?: string[];  // concept ids that this result is edge-adjacent to
}

interface Cluster {
  label: string;
  concepts: string[];  // concept contents (not ids) that anchor this cluster
  members: ResultItem[];
}

async function fetchNeighborConcepts(
  state: GlobalPluginState,
  resultIds: string[],
): Promise<Map<string, string[]>> {
  const neighborMap = new Map<string, string[]>();
  if (resultIds.length === 0) return neighborMap;

  // Fetch concept contents adjacent to any result via mentions/about_concept/
  // artifact_mentions. We collapse all three edge types since for clustering
  // purposes "what concepts does this node touch" is the interesting signal.
  try {
    for (const rid of resultIds) {
      const rows = await state.store.queryFirst<{ id: string; content: string }>(
        `SELECT VALUE ->mentions->concept AS out FROM ${rid}
         UNION SELECT VALUE ->about_concept->concept AS out FROM ${rid}
         UNION SELECT VALUE ->artifact_mentions->concept AS out FROM ${rid}`,
      ).catch(() => []);
      // Different traversal shape — just grab concept ids from any returned rows
      const contents: string[] = [];
      for (const r of rows) {
        const id = (r as any).out ?? (r as any).id;
        if (id) contents.push(String(id));
      }
      if (contents.length > 0) neighborMap.set(rid, contents);
    }
  } catch (e) {
    swallow("clusterScan:neighbors", e);
  }

  return neighborMap;
}

function clusterByOverlap(items: ResultItem[]): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  // Greedy pass: for each unassigned item, find other items whose neighbor
  // lists overlap by >= 2 concepts. Form a cluster.
  for (const item of items) {
    if (assigned.has(item.id)) continue;
    const neighbors = new Set(item.neighbors ?? []);
    if (neighbors.size === 0) {
      // Will be surfaced as a singleton below
      continue;
    }

    const members: ResultItem[] = [item];
    const sharedConcepts = new Set(neighbors);

    for (const other of items) {
      if (other.id === item.id || assigned.has(other.id)) continue;
      const otherNeighbors = new Set(other.neighbors ?? []);
      if (otherNeighbors.size === 0) continue;
      let overlap = 0;
      for (const n of neighbors) if (otherNeighbors.has(n)) overlap++;
      if (overlap >= 2) {
        members.push(other);
        for (const n of otherNeighbors) sharedConcepts.add(n);
        assigned.add(other.id);
      }
    }

    if (members.length >= 2) {
      assigned.add(item.id);
      clusters.push({
        label: `${members.length} items sharing ${[...sharedConcepts].length} concepts`,
        concepts: [...sharedConcepts].slice(0, 5),
        members,
      });
    }
  }

  // Singletons go into their own "ungrouped" bucket so the caller still sees them
  const singletons = items.filter(i => !assigned.has(i.id));
  if (singletons.length > 0) {
    clusters.push({
      label: `${singletons.length} ungrouped`,
      concepts: [],
      members: singletons,
    });
  }

  return clusters;
}

export async function handleClusterScan(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = String(args.query ?? "").trim();
  const limit = Math.min(15, Math.max(5, Number(args.limit) || 10));

  if (!query) {
    return { content: [{ type: "text", text: "Error: `query` is required." }] };
  }

  const { store, embeddings } = state;
  if (!embeddings.isAvailable() || !store.isAvailable()) {
    return { content: [{ type: "text", text: "Error: embeddings or store unavailable." }] };
  }

  // 1. Vector search — reuse the existing recall primitive shape.
  let vec: number[];
  try {
    vec = await embeddings.embed(query);
  } catch (e) {
    return { content: [{ type: "text", text: `Error embedding query: ${e instanceof Error ? e.message : "unknown"}` }] };
  }

  const searchResults = await store.vectorSearch(vec, session.sessionId, {
    turn: Math.ceil(limit / 2),
    concept: limit,
    memory: limit,
    artifact: Math.ceil(limit / 2),
  }).catch(() => []);

  const items: ResultItem[] = searchResults.slice(0, limit * 2).map((r: any) => ({
    id: String(r.id),
    text: String(r.text ?? "").slice(0, 200),
    table: String(r.table ?? ""),
    score: Number(r.score ?? 0),
  }));

  if (items.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, query, clusters: [], note: "No results above similarity threshold." }, null, 2),
      }],
    };
  }

  // 2. Fetch concept neighbors for each result so we can cluster.
  const neighbors = await fetchNeighborConcepts(state, items.map(i => i.id));
  for (const item of items) {
    item.neighbors = neighbors.get(item.id) ?? [];
  }

  // 3. Group by neighbor overlap.
  const clusters = clusterByOverlap(items);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        query,
        total_results: items.length,
        cluster_count: clusters.length,
        clusters: clusters.map(c => ({
          label: c.label,
          concept_anchors: c.concepts.slice(0, 3),
          members: c.members.map(m => ({
            table: m.table,
            score: Number(m.score.toFixed(3)),
            preview: m.text,
          })),
        })),
      }, null, 2),
    }],
  };
}
