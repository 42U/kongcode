/**
 * MCP tools for subagent-driven background processing.
 *
 * fetch_pending_work — Claims the next pending item and returns
 *   instructions + data for the subagent to process.
 * commit_work_results — Accepts the subagent's extraction output
 *   and persists it to SurrealDB via existing write functions.
 *
 * These tools replace the Anthropic SDK direct calls. The LLM
 * reasoning now happens in the subagent (Opus) itself, not in
 * a separate API call from the MCP server.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import type { PriorExtractions } from "../engine/daemon-types.js";
import { buildSystemPrompt, buildTranscript, writeExtractionResults } from "../engine/memory-daemon.js";
import { createSoul, seedSoulAsCoreMemory, reviseSoul, getSoul, checkGraduation, getQualitySignals } from "../engine/soul.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingWorkItem {
  id: string;
  work_type: string;
  session_id: string;
  surreal_session_id?: string;
  task_id?: string;
  project_id?: string;
  payload?: Record<string, unknown>;
  priority: number;
}

// Skill extraction JSON schema (matches skills.ts)
const skillSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    preconditions: { type: "string" },
    steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, description: { type: "string" } } } },
    postconditions: { type: "string" },
  },
  required: ["name", "description", "steps"],
};

// Soul document schema (matches soul.ts)
const soulSchema = {
  type: "object",
  properties: {
    working_style: { type: "array", items: { type: "string" } },
    emotional_dimensions: { type: "array", items: { type: "object" } },
    self_observations: { type: "array", items: { type: "string" } },
    earned_values: { type: "array", items: { type: "object" } },
  },
  required: ["working_style", "emotional_dimensions", "self_observations", "earned_values"],
};

// ── fetch_pending_work ───────────────────────────────────────────────────────

export async function handleFetchPendingWork(
  state: GlobalPluginState,
  _session: SessionState,
  _args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { store } = state;

  if (!store.isAvailable()) {
    return text("Database unavailable. Cannot fetch pending work.");
  }

  try {
    // Reset stale items stuck in "processing" > 10 min
    await store.queryExec(
      `UPDATE pending_work SET status = "pending" WHERE status = "processing" AND created_at < time::now() - 10m`,
    ).catch(() => {});

    // Atomically claim the highest-priority pending item
    const items = await store.queryFirst<PendingWorkItem>(
      `UPDATE pending_work SET status = "processing" WHERE status = "pending" ORDER BY priority ASC, created_at ASC LIMIT 1 RETURN AFTER`,
    );

    if (items.length === 0) {
      return text(JSON.stringify({ empty: true, message: "No pending work items. You are done." }));
    }

    const item = items[0];
    log.info(`[pending_work] Claimed ${item.work_type} (${item.id})`);

    const result = await buildWorkPayload(item, state);
    return text(JSON.stringify(result));
  } catch (e) {
    log.error("[pending_work] fetch error:", e);
    return text(JSON.stringify({ error: String(e) }));
  }
}

async function buildWorkPayload(
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
  const { store } = state;

  switch (item.work_type) {
    case "extraction": {
      const turns = await store.getSessionTurnsRich(item.session_id, 50);
      const transcript = buildTranscript(turns as any);
      const prior: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
      const instructions = buildSystemPrompt(false, false, prior);
      return {
        work_id: item.id,
        work_type: "extraction",
        instructions,
        data: { transcript: transcript.slice(0, 30000), turn_count: turns.length },
        output_format: "Return ONLY valid JSON matching the schema in the instructions. All fields are arrays — use [] if empty.",
      };
    }

    case "reflection": {
      const turns = await store.getSessionTurns(item.session_id, 15);
      const transcript = turns.map(t => `[${t.role}] ${(t.text ?? "").slice(0, 300)}`).join("\n");
      return {
        work_id: item.id,
        work_type: "reflection",
        instructions: `Reflect on this session. Write 2-4 sentences about: what went well, what could improve, any patterns worth noting. Be specific and actionable. If the session was too trivial for reflection, respond with just "skip".`,
        data: { transcript: transcript.slice(0, 15000), turn_count: turns.length },
        output_format: "Return plain text (2-4 sentences). Return exactly 'skip' if the session is too trivial.",
      };
    }

    case "skill_extract": {
      const turns = await store.getSessionTurns(item.session_id, 30);
      const transcript = turns.map(t => `[${t.role}] ${(t.text ?? "").slice(0, 300)}`).join("\n");
      return {
        work_id: item.id,
        work_type: "skill_extract",
        instructions: `Extract a reusable skill procedure from this session. Generic patterns only (no specific file paths or variable names). Return null if no clear multi-step workflow.`,
        data: { transcript: transcript.slice(0, 20000), turn_count: turns.length },
        output_format: "Return JSON: " + JSON.stringify(skillSchema) + " or the word 'null' if no skill found.",
      };
    }

    case "causal_graduate": {
      const groups = await store.queryFirst<{ chain_type: string; cnt: number; descriptions: string[] }>(
        `SELECT chain_type, count() AS cnt, array::group(description) AS descriptions
         FROM causal_chain WHERE success = true AND confidence >= 0.7
         GROUP BY chain_type`,
      );
      const eligible = groups.filter(g => g.cnt >= 3);
      if (eligible.length === 0) {
        // No chains to graduate — mark complete immediately
        await store.queryExec(`UPDATE $id SET status = "completed", completed_at = time::now()`, { id: item.id });
        return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "No causal chains ready for graduation. Already marked complete." };
      }
      return {
        work_id: item.id,
        work_type: "causal_graduate",
        instructions: `Synthesize reusable procedures from these recurring successful patterns. Generic — no specific file paths or variable names. Return one skill JSON per pattern group.`,
        data: { groups: eligible.map(g => ({ chain_type: g.chain_type, count: g.cnt, descriptions: g.descriptions.slice(0, 8) })) },
        output_format: "Return JSON array of skills: [" + JSON.stringify(skillSchema) + ", ...]. Return [] if no clear patterns.",
      };
    }

    case "soul_generate": {
      const report = await checkGraduation(store);
      if (!report.ready) {
        await store.queryExec(`UPDATE $id SET status = "completed", completed_at = time::now()`, { id: item.id });
        return { work_id: item.id, work_type: "soul_generate", empty: true, message: "Not ready for graduation yet. Already marked complete." };
      }
      const [reflections, causalChains, monologues] = await Promise.all([
        store.queryFirst<{ text: string; category: string }>(`SELECT text, category FROM reflection ORDER BY created_at DESC LIMIT 15`).catch(() => []),
        store.queryFirst<{ description: string; chain_type: string }>(`SELECT description, chain_type FROM causal_chain ORDER BY created_at DESC LIMIT 10`).catch(() => []),
        store.queryFirst<{ content: string }>(`SELECT content FROM monologue ORDER BY timestamp DESC LIMIT 10`).catch(() => []),
      ]);
      const quality = await getQualitySignals(store);
      return {
        work_id: item.id,
        work_type: "soul_generate",
        instructions: `You are KongCode, a graph-backed coding agent with persistent memory. Based on YOUR OWN memory graph data below, write your initial Soul document. Be honest, not aspirational. Only claim what the data supports.`,
        data: {
          reflections: (reflections as any[]).map(r => `[${r.category}] ${r.text}`),
          causal_chains: (causalChains as any[]).map(c => `[${c.chain_type}] ${c.description}`),
          monologues: (monologues as any[]).map(m => m.content),
          quality: {
            retrieval_utilization: `${(quality.avgRetrievalUtilization * 100).toFixed(0)}%`,
            skill_success_rate: `${(quality.skillSuccessRate * 100).toFixed(0)}%`,
            tool_failure_rate: `${(quality.toolFailureRate * 100).toFixed(0)}%`,
          },
        },
        output_format: "Return JSON: " + JSON.stringify(soulSchema),
      };
    }

    case "soul_evolve": {
      const soul = await getSoul(store);
      if (!soul) {
        await store.queryExec(`UPDATE $id SET status = "completed", completed_at = time::now()`, { id: item.id });
        return { work_id: item.id, work_type: "soul_evolve", empty: true, message: "No soul exists yet. Already marked complete." };
      }
      const [reflections, causalChains, monologues] = await Promise.all([
        store.queryFirst<{ text: string }>(`SELECT text FROM reflection WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
        store.queryFirst<{ description: string }>(`SELECT description FROM causal_chain WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
        store.queryFirst<{ content: string }>(`SELECT content FROM monologue WHERE timestamp > $since ORDER BY timestamp DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
      ]);
      if (reflections.length === 0 && causalChains.length === 0 && monologues.length === 0) {
        await store.queryExec(`UPDATE $id SET status = "completed", completed_at = time::now()`, { id: item.id });
        return { work_id: item.id, work_type: "soul_evolve", empty: true, message: "No new experience since last soul update. Already marked complete." };
      }
      return {
        work_id: item.id,
        work_type: "soul_evolve",
        instructions: `You are revising your own Soul document based on new experience. Return JSON with ONLY the fields that changed. Omit unchanged fields. If nothing meaningful changed, return {}. Be honest — revise based on evidence, not aspiration.`,
        data: {
          current_soul: { working_style: soul.working_style, emotional_dimensions: soul.emotional_dimensions, self_observations: soul.self_observations, earned_values: soul.earned_values },
          new_reflections: (reflections as any[]).map(r => r.text),
          new_causal_chains: (causalChains as any[]).map(c => c.description),
          new_monologues: (monologues as any[]).map(m => m.content),
        },
        output_format: "Return JSON with ONLY changed fields from the soul schema. Return {} if nothing changed.",
      };
    }

    case "handoff_note": {
      const turns = await store.getSessionTurns(item.session_id, 15);
      const transcript = turns.map(t => `[${t.role}] ${(t.text ?? "").slice(0, 200)}`).join("\n");
      return {
        work_id: item.id,
        work_type: "handoff_note",
        instructions: `Summarize this session for handoff to your next self. What was worked on, what's unfinished, what to remember. 2-3 sentences. Write in first person.`,
        data: { transcript: transcript.slice(0, 10000), turn_count: turns.length },
        output_format: "Return plain text (2-3 sentences in first person).",
      };
    }

    case "deferred_cleanup": {
      // Same as extraction but for orphaned sessions
      const turns = await store.getSessionTurnsRich(item.session_id, 50);
      const transcript = buildTranscript(turns as any);
      const prior: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
      const instructions = buildSystemPrompt(false, false, prior);
      return {
        work_id: item.id,
        work_type: "deferred_cleanup",
        instructions,
        data: { transcript: transcript.slice(0, 30000), turn_count: turns.length },
        output_format: "Return ONLY valid JSON matching the schema in the instructions. All fields are arrays — use [] if empty.",
      };
    }

    default: {
      await store.queryExec(`UPDATE $id SET status = "completed", completed_at = time::now()`, { id: item.id });
      return { work_id: item.id, work_type: item.work_type, empty: true, message: `Unknown work type: ${item.work_type}` };
    }
  }
}

// ── commit_work_results ──────────────────────────────────────────────────────

export async function handleCommitWorkResults(
  state: GlobalPluginState,
  _session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { store, embeddings } = state;
  const workId = String(args.work_id ?? "");
  const results = args.results as Record<string, unknown> | string | undefined;

  if (!workId) return text("Error: work_id is required");
  if (!store.isAvailable()) return text("Error: database unavailable");

  // Look up the work item to know what type it is
  const items = await store.queryFirst<PendingWorkItem>(
    `SELECT * FROM $id`, { id: workId },
  );
  if (items.length === 0) return text(`Error: work item not found: ${workId}`);

  const item = items[0];

  try {
    const outcome = await commitResults(item, results, state);
    // Mark completed
    await store.queryExec(
      `UPDATE $id SET status = "completed", completed_at = time::now()`,
      { id: workId },
    );
    log.info(`[pending_work] Completed ${item.work_type} (${workId})`);
    return text(JSON.stringify({ success: true, work_type: item.work_type, ...outcome }));
  } catch (e) {
    // Mark failed
    await store.queryExec(
      `UPDATE $id SET status = "failed", completed_at = time::now()`,
      { id: workId },
    ).catch(() => {});
    log.error(`[pending_work] Failed ${item.work_type} (${workId}):`, e);
    return text(JSON.stringify({ success: false, error: String(e) }));
  }
}

async function commitResults(
  item: PendingWorkItem,
  results: Record<string, unknown> | string | undefined,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
  const { store, embeddings } = state;

  switch (item.work_type) {
    case "extraction":
    case "deferred_cleanup": {
      if (typeof results === "string") {
        // Try to parse JSON from the subagent's text response
        try { results = JSON.parse(results); } catch {
          const match = (results as string).match(/\{[\s\S]*\}/);
          if (match) results = JSON.parse(match[0]);
          else throw new Error("Could not parse extraction JSON");
        }
      }
      const prior: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
      const counts = await writeExtractionResults(
        results as Record<string, any>,
        item.session_id,
        store,
        embeddings,
        prior,
        item.task_id,
        item.project_id,
      );
      return { counts };
    }

    case "reflection": {
      const reflText = typeof results === "string" ? results : String((results as any)?.text ?? results);
      if (reflText.length < 20 || reflText.toLowerCase().trim() === "skip") {
        return { skipped: true };
      }
      let reflEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { reflEmb = await embeddings.embed(reflText); } catch { /* ok */ }
      }
      // Dedup
      if (reflEmb?.length) {
        const existing = await store.queryFirst<{ score: number }>(
          `SELECT vector::similarity::cosine(embedding, $vec) AS score FROM reflection WHERE embedding != NONE ORDER BY score DESC LIMIT 1`,
          { vec: reflEmb },
        );
        if (existing[0]?.score > 0.85) return { deduplicated: true };
      }
      const record: Record<string, unknown> = {
        session_id: item.session_id,
        text: reflText,
        category: "session_review",
        severity: "minor",
        importance: 7.0,
      };
      if (reflEmb?.length) record.embedding = reflEmb;
      const rows = await store.queryFirst<{ id: string }>(`CREATE reflection CONTENT $record RETURN id`, { record });
      if (rows[0]?.id && item.surreal_session_id) {
        await store.relate(String(rows[0].id), "reflects_on", item.surreal_session_id).catch(() => {});
      }
      store.clearReflectionCache();
      return { reflection_id: rows[0]?.id };
    }

    case "skill_extract": {
      const parsed = parseSkillResult(results);
      if (!parsed) return { skipped: true, reason: "no valid skill found" };
      return await createSkillRecord(parsed, item, state);
    }

    case "causal_graduate": {
      const skills = parseCausalGraduationResult(results);
      let created = 0;
      for (const parsed of skills) {
        await createSkillRecord(parsed, item, state);
        created++;
      }
      return { skills_created: created };
    }

    case "soul_generate": {
      const doc = parseSoulResult(results);
      if (!doc) throw new Error("Invalid soul document JSON");
      const now = new Date().toISOString();
      const soulDoc = {
        working_style: doc.working_style ?? [],
        emotional_dimensions: (doc.emotional_dimensions ?? []).map((d: any) => ({ ...d, adopted_at: now })),
        self_observations: doc.self_observations ?? [],
        earned_values: doc.earned_values ?? [],
      };
      const success = await createSoul(soulDoc, store);
      if (!success) throw new Error("Failed to create soul record");
      const soul = await getSoul(store);
      if (soul) await seedSoulAsCoreMemory(soul, store);
      log.info("[GRADUATION] Soul created by subagent!");
      return { graduated: true };
    }

    case "soul_evolve": {
      const changes = parseSoulResult(results);
      if (!changes || Object.keys(changes).length === 0) return { skipped: true, reason: "no changes" };
      let revised = 0;
      for (const section of ["working_style", "emotional_dimensions", "self_observations", "earned_values"] as const) {
        if (changes[section] && Array.isArray(changes[section]) && changes[section].length > 0) {
          await reviseSoul(section, changes[section], "Evolved by subagent based on new experience", store);
          revised++;
        }
      }
      return { sections_revised: revised };
    }

    case "handoff_note": {
      const noteText = typeof results === "string" ? results : String((results as any)?.text ?? results);
      if (noteText.length < 20) return { skipped: true };
      let noteEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { noteEmb = await embeddings.embed(noteText); } catch { /* ok */ }
      }
      const record: Record<string, unknown> = {
        text: noteText,
        category: "handoff",
        importance: 8,
        source: `session:${item.session_id}`,
      };
      if (noteEmb?.length) record.embedding = noteEmb;
      await store.queryFirst<{ id: string }>(`CREATE memory CONTENT $record RETURN id`, { record });
      return { stored: true };
    }

    default:
      return { skipped: true, reason: `unknown work_type: ${item.work_type}` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: s }] };
}

interface ExtractedSkill {
  name: string;
  description: string;
  preconditions?: string;
  steps: { tool: string; description: string }[];
  postconditions?: string;
}

function parseSkillResult(results: unknown): ExtractedSkill | null {
  let parsed: ExtractedSkill;
  if (typeof results === "string") {
    if (results.trim() === "null" || results.trim() === "None") return null;
    try { parsed = JSON.parse(results); } catch {
      const match = results.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { parsed = JSON.parse(match[0]); } catch { return null; }
    }
  } else {
    parsed = results as ExtractedSkill;
  }
  if (!parsed?.name || !Array.isArray(parsed?.steps) || parsed.steps.length === 0) return null;
  return parsed;
}

function parseCausalGraduationResult(results: unknown): ExtractedSkill[] {
  let arr: unknown[];
  if (typeof results === "string") {
    try { arr = JSON.parse(results); } catch {
      const match = results.match(/\[[\s\S]*\]/);
      if (!match) return [];
      try { arr = JSON.parse(match[0]); } catch { return []; }
    }
  } else if (Array.isArray(results)) {
    arr = results;
  } else {
    return [];
  }
  return arr.map(item => parseSkillResult(item)).filter((s): s is ExtractedSkill => s !== null);
}

function parseSoulResult(results: unknown): Record<string, any> | null {
  if (typeof results === "string") {
    try { return JSON.parse(results); } catch {
      const match = results.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); } catch { return null; }
    }
  }
  return (results && typeof results === "object") ? results as Record<string, any> : null;
}

async function createSkillRecord(
  parsed: ExtractedSkill,
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
  const { store, embeddings } = state;
  let skillEmb: number[] | null = null;
  if (embeddings.isAvailable()) {
    try { skillEmb = await embeddings.embed(`${parsed.name}: ${parsed.description}`); } catch { /* ok */ }
  }
  const record: Record<string, unknown> = {
    name: String(parsed.name).slice(0, 100),
    description: String(parsed.description).slice(0, 200),
    preconditions: parsed.preconditions ? String(parsed.preconditions).slice(0, 200) : undefined,
    steps: parsed.steps.slice(0, 8).map(s => ({ tool: String(s.tool ?? "unknown"), description: String(s.description ?? "").slice(0, 200) })),
    postconditions: parsed.postconditions ? String(parsed.postconditions).slice(0, 200) : undefined,
    confidence: 1.0,
    active: true,
  };
  if (skillEmb?.length) record.embedding = skillEmb;
  const rows = await store.queryFirst<{ id: string }>(`CREATE skill CONTENT $record RETURN id`, { record });
  const skillId = String(rows[0]?.id ?? "");
  if (skillId && item.task_id) {
    await store.relate(skillId, "skill_from_task", item.task_id).catch(() => {});
  }
  return { skill_id: skillId, name: parsed.name };
}
