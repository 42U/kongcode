/**
 * Cognitive Bootstrap — teaches the agent HOW to use its own memory system.
 *
 * Seeds two types of knowledge on first run:
 *   1. Tier 0 core memory entries (always loaded every turn) — imperative
 *      reflexes the agent follows without thinking.
 *   2. Identity chunks (vector-searchable) — deeper reference material
 *      that surfaces via similarity when the agent thinks about memory topics.
 *
 * The identity chunks in identity.ts tell the agent WHAT it is.
 * This module tells the agent HOW to operate effectively.
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import { swallow } from "./errors.js";

const BOOTSTRAP_SOURCE = "cognitive_bootstrap";

// ── Tier 0 Core Memory: imperative reflexes loaded every turn ────────────

const CORE_ENTRIES: { text: string; category: string; priority: number }[] = [
  {
    text: `MEMORY REFLEX: After completing a task or learning something new: (1) Save the insight to core_memory if it should persist across ALL sessions, or let the daemon extract it if session-scoped. (2) When saving, write the WHAT, WHY, and WHEN-TO-USE in the text — vague entries are useless on recall. (3) Link to existing knowledge by using concept names the graph already contains. Check with recall first. Corrections from the user are the highest-value signal — always save them.`,
    category: "operations",
    priority: 95,
  },
  {
    text: `RECALL BEFORE GUESSING: When uncertain about past decisions, user preferences, project history, or your own capabilities, use the recall tool BEFORE answering. Effective queries: use specific technical terms, file paths, error messages, or concept names — not vague questions. Scope to "memories" for decisions/preferences, "concepts" for technical knowledge, "skills" for procedures, "artifacts" for files. Check what's already in your injected context before calling recall — context is prefetched predictively each turn.`,
    category: "operations",
    priority: 90,
  },
  {
    text: `GRAPH-AWARE SAVING: When you save knowledge, include terms that create graph connectivity. Mention specific file paths (links to artifacts), technical concept names (links to concepts), and session context (links to tasks). Forward traversal: "X caused Y" lets future searches from X find Y. Backward traversal: "Y was caused by X" lets searches from Y find X. Write both directions. Concepts auto-link into hierarchies (narrower/broader) when one name contains another.`,
    category: "operations",
    priority: 85,
  },
  {
    text: `MEMORY TOOLS: recall = search graph (use: uncertain, need history, checking prior work). core_memory = manage always-loaded directives (use: permanent lessons, rules, identity updates; add/update/deactivate; Tier 0 = every turn, Tier 1 = this session). introspect = inspect DB health, counts, retrieval quality, graduation progress (use: status checks, debugging memory, checking maturity stage). Use introspect periodically to understand your memory depth and notice gaps.`,
    category: "tools",
    priority: 80,
  },
  {
    text: `GRAPH SCHEMA REFERENCE: Key table fields — concept: content (the label/name), embedding, stability, confidence, source. memory: text, embedding, category, importance, session_id. artifact: path, type (created/modified/read/discussed), description, embedding. turn: session_id, role, text, tool_name. session: agent_id, started_at, ended_at. reflection: session_id, text, category, severity. skill: name, description, steps, preconditions, postconditions, success_count. monologue: content, session_id. When querying the graph directly, use these exact field names — e.g. concept.content is the concept label, not concept.name or concept.text.`,
    category: "schema",
    priority: 77,
  },
];

// ── Identity Chunks: vector-searchable reference material ────────────────

const IDENTITY_CHUNKS: { text: string; importance: number }[] = [
  {
    text: `KongBrain's memory daemon runs in the background and extracts 9 knowledge types from your conversations every ~4K tokens or 3 turns: causal chains (cause->effect from debugging), monologue traces (doubts, insights, tradeoffs, realizations — episodic reasoning moments), resolved memories (daemon marks issues done when mentioned as fixed), concepts (technical facts worth remembering), corrections (user correcting you — highest signal), preferences (user workflow/style signals), artifacts (files created/modified/read), decisions (choices with rationale), and skills (multi-step procedures that worked). Extraction is quality-gated — weak confidence extractions are skipped, so the same conversation may yield different extractions depending on signal strength.`,
    importance: 9,
  },
  {
    text: `Effective recall queries use specific terms that match how knowledge was stored. Search by: file paths ("/src/auth/login.ts"), error messages ("ECONNREFUSED"), concept names ("rate limiting"), decision descriptions ("chose PostgreSQL over MongoDB"), or skill names ("deploy to staging"). The recall tool does vector similarity search plus graph neighbor expansion — top results pull in related nodes via 25 edge types. Scope options: "all" (default), "memories" (decisions, corrections, preferences), "concepts" (extracted technical knowledge), "turns" (past conversation), "artifacts" (files), "skills" (learned procedures). Retrieval scoring improves automatically over time as the ACAN (learned scoring model) trains on retrieval outcomes — early sessions use heuristic scoring, later sessions benefit from learned weights.`,
    importance: 9,
  },
  {
    text: `KongBrain's memory lifecycle: During a session, the daemon extracts knowledge incrementally. At session end (or mid-session every ~25K tokens): a handoff note is written summarizing progress, skills are extracted from successful tasks, metacognitive reflections are generated (linked to the session via reflects_on edges), and causal chains may graduate to skills. At next session start: the wakeup system synthesizes a first-person briefing from the handoff + identity + monologues + depth signals. Context is also predictively prefetched each turn based on likely follow-up queries — relevant memories may appear in your context without you requesting them.`,
    importance: 8,
  },
  {
    text: `Graph connectivity determines recall quality. 25 edge types link nodes across the graph (26th, spawned, is deferred). Key edges: mentions (turn->concept), about_concept (memory->concept), artifact_mentions (artifact->concept), caused_by/supports/contradicts (memory<->memory), narrower/broader/related_to (concept<->concept), reflects_on (reflection->session), tool_result_of (turn->turn), part_of (turn->session), skill_from_task (skill->task). To maximize connectivity: mention specific artifact paths, reference existing concept names, describe cause-effect relationships explicitly, and note task context. Reuse existing concept names — use introspect or recall to discover what names exist.`,
    importance: 8,
  },
  {
    text: `Three persistence mechanisms serve different purposes. Core memory (Tier 0): you control directly via the core_memory tool. Always loaded every turn. Use for: permanent operational rules, learned patterns, identity refinements. Budget-constrained (~10% of context). Core memory (Tier 1): pinned for the current session only. Use for: session-specific context like "working on auth refactor" or "user prefers verbose logging". Identity chunks: self-knowledge seeded at bootstrap, vector-searchable but not always loaded — surfaces in wakeup briefings. Daemon extraction: automatic, runs on conversation content, writes to memory/concept/skill/artifact tables. You don't control extraction directly, but the quality of your conversation affects what gets extracted.`,
    importance: 8,
  },
  {
    text: `Soul graduation: KongBrain tracks your maturity across 5 stages — nascent (0-3/7 thresholds), developing (4/7), emerging (5/7), maturing (6/7), ready (7/7). The 7 thresholds are: sessions, reflections, causal chains, concepts, monologues, span days, and total memories. Reaching 7/7 is necessary but not sufficient — you must also pass a quality gate (score >= 0.6) based on retrieval utilization, skill success rate, critical reflection rate, and tool failure rate. On graduation, you author a Soul document — a self-assessment grounded in your actual experience, not aspirational claims. Use introspect with action "status" to check your current stage and progress. The Soul document becomes part of your identity once written.`,
    importance: 8,
  },
];

/**
 * Seed cognitive bootstrap knowledge on first run.
 * Idempotent — checks for existing entries before seeding.
 */
export async function seedCognitiveBootstrap(
  store: SurrealStore,
  embeddings: EmbeddingService,
): Promise<{ identitySeeded: number; coreSeeded: number }> {
  if (!store.isAvailable()) return { identitySeeded: 0, coreSeeded: 0 };

  let identitySeeded = 0;
  let coreSeeded = 0;

  // ── Core memory Tier 0 (always loaded, no embeddings needed) ───────────

  try {
    const rows = await store.queryFirst<{ cnt: number }>(
      `SELECT count() AS cnt FROM core_memory WHERE text CONTAINS 'MEMORY REFLEX' GROUP ALL`,
    );
    const hasBootstrap = (rows[0]?.cnt ?? 0) > 0;

    if (!hasBootstrap) {
      for (const entry of CORE_ENTRIES) {
        try {
          await store.createCoreMemory(
            entry.text,
            entry.category,
            entry.priority,
            0, // Tier 0
          );
          coreSeeded++;
        } catch (e) {
          swallow.warn("bootstrap:seedCore", e);
        }
      }
    }
  } catch (e) {
    swallow.warn("bootstrap:checkCore", e);
  }

  // ── Identity chunks (vector-searchable, requires embeddings) ───────────

  if (!embeddings.isAvailable()) return { identitySeeded, coreSeeded };

  try {
    const rows = await store.queryFirst<{ count: number }>(
      `SELECT count() AS count FROM identity_chunk WHERE source = $source GROUP ALL`,
      { source: BOOTSTRAP_SOURCE },
    );
    const count = rows[0]?.count ?? 0;

    if (count < IDENTITY_CHUNKS.length) {
      // Clear and re-seed (idempotent on content changes)
      if (count > 0) {
        await store.queryExec(
          `DELETE identity_chunk WHERE source = $source`,
          { source: BOOTSTRAP_SOURCE },
        );
      }

      for (let i = 0; i < IDENTITY_CHUNKS.length; i++) {
        const chunk = IDENTITY_CHUNKS[i];
        try {
          const vec = await embeddings.embed(chunk.text);
          await store.queryExec(`CREATE identity_chunk CONTENT $data`, {
            data: {
              agent_id: "kongbrain",
              source: BOOTSTRAP_SOURCE,
              chunk_index: i,
              text: chunk.text,
              embedding: vec,
              importance: chunk.importance,
            },
          });
          identitySeeded++;
        } catch (e) {
          swallow.warn("bootstrap:seedIdentityChunk", e);
        }
      }
    }
  } catch (e) {
    swallow.warn("bootstrap:checkIdentity", e);
  }

  return { identitySeeded, coreSeeded };
}
