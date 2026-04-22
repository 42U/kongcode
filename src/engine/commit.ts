/**
 * commitKnowledge — the single write path.
 *
 * Every graph write (concepts, memories, artifacts, skills, reflections, etc.)
 * should go through this function. It wraps the row insert with the full
 * set of auto-sealing edges, so callers can't accidentally skip linking.
 *
 * Before this existed, write paths did their own linking (the dormant
 * memory-daemon.ts did it thoroughly; newer paths like pending-work.ts:527
 * partially bypassed the linking helpers, leaving concepts unlinked). That
 * was the root cause of the "substrate doesn't auto-seal" problem in 0.3.x.
 *
 * 0.4.0 kicks off with commitKnowledge handling the "concept" kind only.
 * Additional kinds (memory, artifact, skill, reflection, monologue,
 * correction, preference, decision) come online as their writers are
 * migrated off their bespoke paths.
 */

import type { GlobalPluginState } from "./state.js";
import type { ConceptProvenance } from "./surreal.js";
import {
  linkToRelevantConcepts,
  linkConceptHierarchy,
} from "./concept-extract.js";
import { swallow } from "./errors.js";

// ── Payload shapes (discriminated union) ──────────────────────────────────

export interface CommitConceptData {
  kind: "concept";
  /** The concept label (also used as the embedding target). */
  name: string;
  /** Optional source node asserting this concept (turn:xxx, memory:xxx, artifact:xxx). */
  sourceId?: string;
  /** Edge type from sourceId to the concept. Required if sourceId set. */
  edgeName?: string;
  /** Tag passed to upsertConcept as `source` — used in provenance. */
  source?: string;
  /** Rich provenance (session_id, source_kind, skill_name). Preserved across migration. */
  provenance?: ConceptProvenance;
  /** Run linkConceptHierarchy (broader/narrower) — default true. */
  linkHierarchy?: boolean;
  /** Run linkToRelevantConcepts against other concepts — default true. */
  linkRelated?: boolean;
  /** Precomputed embedding vector. Skip embed() if provided. */
  precomputedVec?: number[] | null;
}

// Future kinds will extend this union:
// | CommitMemoryData
// | CommitArtifactData
// | CommitSkillData
// | CommitReflectionData
// | CommitMonologueData
// | CommitCorrectionData
// | CommitPreferenceData
// | CommitDecisionData
export type CommitData = CommitConceptData;

export interface CommitResult {
  /** The record ID written (e.g. "concept:abc123"). */
  id: string;
  /** Number of auto-seal edges created for this write. Observable for verification. */
  edges: number;
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function commitKnowledge(
  state: GlobalPluginState,
  data: CommitData,
): Promise<CommitResult> {
  switch (data.kind) {
    case "concept":
      return commitConcept(state, data);
    default: {
      // Exhaustiveness check — new kinds must add a case here.
      const _exhaustive: never = data.kind;
      throw new Error(`commitKnowledge: unsupported kind ${String(_exhaustive)}`);
    }
  }
}

// ── Per-kind implementations ──────────────────────────────────────────────

async function commitConcept(
  state: GlobalPluginState,
  data: CommitConceptData,
): Promise<CommitResult> {
  const { store, embeddings } = state;
  const logTag = `commit:concept:${data.source ?? "anon"}`;

  // 1. Embed the name (or reuse caller's vec).
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(data.name); }
    catch (e) { swallow(`${logTag}:embed`, e); }
  }

  // 2. Upsert the concept row (provenance passed through when supplied).
  const conceptId = await store.upsertConcept(data.name, embedding, data.source, data.provenance);
  let edges = 0;

  // 3. Link source → concept via the requested edge, if caller provided one.
  if (data.sourceId && data.edgeName) {
    try {
      await store.relate(data.sourceId, data.edgeName, conceptId);
      edges++;
    } catch (e) {
      swallow(`${logTag}:relate`, e);
    }
  }

  // 4. Auto-seal: concept → other concepts (narrower/broader hierarchy).
  if (data.linkHierarchy !== false) {
    const before = edges;
    try {
      await linkConceptHierarchy(conceptId, data.name, store, embeddings, logTag);
      // linkConceptHierarchy writes edges internally; we don't get a count back,
      // so we approximate by marking "hierarchy attempted" — +1 for observability.
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:hierarchy`, e);
      edges = before;
    }
  }

  // 5. Auto-seal: concept → other concepts (related_to by embedding similarity).
  if (data.linkRelated !== false && embedding && embedding.length > 0) {
    const before = edges;
    try {
      await linkToRelevantConcepts(
        conceptId, "related_to", data.name,
        store, embeddings, logTag,
        5, 0.65, embedding,
      );
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:related`, e);
      edges = before;
    }
  }

  return { id: conceptId, edges };
}
