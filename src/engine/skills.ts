/**
 * Procedural Memory (Skill Library)
 *
 * When the agent successfully completes a multi-step task, extract the procedure
 * as a reusable skill (preconditions, steps, postconditions, outcome).
 * Next time a similar task is requested, inject the proven procedure as context.
 * Skills earn success/failure counts from outcomes — RL-like reinforcement.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { CompleteFn } from "./state.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { linkToRelevantConcepts } from "./concept-extract.js";
import { assertRecordId } from "./surreal.js";

// --- Shared schema for structured output ---

const skillSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    preconditions: { type: "string" },
    steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, description: { type: "string" } } } },
    postconditions: { type: "string" },
  },
  required: ["name", "description", "steps"],
};

// --- Types ---

export interface SkillStep {
  tool: string;
  description: string;
  argsPattern?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  preconditions?: string;
  steps: SkillStep[];
  postconditions?: string;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  confidence: number;
  active: boolean;
  score?: number;
}

export interface ExtractedSkill {
  name: string;
  description: string;
  preconditions: string;
  steps: SkillStep[];
  postconditions: string;
}

// --- Skill Extraction ---

/**
 * Run at session end. If the session had 3+ tool calls and final outcomes succeeded,
 * extract the procedure as a reusable skill.
 */
export async function extractSkill(
  sessionId: string,
  taskId: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
): Promise<string | null> {
  if (!store.isAvailable()) return null;

  const turns = await store.getSessionTurns(sessionId, 50);
  if (turns.length < 4) return null; // Too short for skill extraction

  const transcript = turns
    .map((t) => `[${t.role}] ${(t.text ?? "").slice(0, 300)}`)
    .join("\n");

  try {
    const response = await complete({
      system: `Extract a reusable skill procedure. Generic patterns only (no specific paths). Return null if no clear multi-step workflow.`,
      messages: [{
        role: "user",
        content: `${turns.length} turns:\n${transcript.slice(0, 20000)}`,
      }],
      outputFormat: { type: "json_schema", schema: skillSchema },
    });

    const text = response.text;

    if (text.trim() === "null" || text.trim() === "None") return null;

    // Try direct JSON.parse first (structured output), fall back to regex extraction
    let parsed: ExtractedSkill;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/); // greedy — handles nested objects
      if (!jsonMatch) return null;
      parsed = JSON.parse(jsonMatch[0]) as ExtractedSkill;
    }
    if (!parsed.name || !parsed.description || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    let skillEmb: number[] | null = null;
    if (embeddings.isAvailable()) {
      try { skillEmb = await embeddings.embed(`${parsed.name}: ${parsed.description}`); } catch (e) { swallow("skills:ok", e); }
    }

    const record: Record<string, unknown> = {
      name: String(parsed.name).slice(0, 100),
      description: String(parsed.description).slice(0, 200),
      preconditions: parsed.preconditions ? String(parsed.preconditions).slice(0, 200) : undefined,
      steps: parsed.steps.slice(0, 8).map((s) => ({
        tool: String(s.tool ?? "unknown"),
        description: String(s.description ?? "").slice(0, 200),
      })),
      postconditions: parsed.postconditions ? String(parsed.postconditions).slice(0, 200) : undefined,
      confidence: 1.0,
      active: true,
    };
    if (skillEmb?.length) record.embedding = skillEmb;

    const rows = await store.queryFirst<{ id: string }>(
      `CREATE skill CONTENT $record RETURN id`,
      { record },
    );
    const skillId = String(rows[0]?.id ?? "");

    if (skillId && taskId) {
      await store.relate(skillId, "skill_from_task", taskId).catch(e => swallow.warn("skills:relateSkillTask", e));
    }
    if (skillId) {
      await supersedeOldSkills(skillId, skillEmb ?? [], store);
      // skill_uses_concept: skill → concept
      const skillDesc = `${parsed.name} ${parsed.description ?? ""} ${(parsed.preconditions ?? "")}`;
      await linkToRelevantConcepts(skillId, "skill_uses_concept", skillDesc, store, embeddings, "skills:concepts", 5, 0.65, skillEmb);
    }

    return skillId || null;
  } catch (e) {
    swallow.warn("skills:extract", e);
    return null;
  }
}

// --- Supersession ---

/**
 * After saving a new skill, fade similar existing skills above similarity threshold.
 */
export async function supersedeOldSkills(
  newSkillId: string,
  newEmb: number[],
  store: SurrealStore,
): Promise<void> {
  if (!newEmb.length || !store.isAvailable()) return;
  try {
    const rows = await store.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE id != $sid
         AND (active = NONE OR active = true)
         AND embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT 5`,
      { vec: newEmb, sid: newSkillId },
    );
    for (const row of rows) {
      if ((row.score ?? 0) >= 0.82) {
        await store.queryExec(
          `UPDATE $id SET active = false, superseded_by = $newId`,
          { id: row.id, newId: newSkillId },
        );
      }
    }
  } catch (e) { swallow.warn("skills:supersedeOld", e); }
}

// --- Skill Retrieval ---

/**
 * Vector search on the skill table. Called from graphTransformContext
 * when the intent is code-write, code-debug, or multi-step.
 */
export async function findRelevantSkills(
  queryVec: number[],
  limit = 3,
  store?: SurrealStore,
): Promise<Skill[]> {
  if (!store?.isAvailable()) return [];

  try {
    const rows = await store.queryFirst<any>(
      `SELECT id, name, description, preconditions, steps, postconditions,
              success_count AS successCount, failure_count AS failureCount,
              avg_duration_ms AS avgDurationMs,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE embedding != NONE AND array::len(embedding) > 0 AND (active = NONE OR active = true)
       ORDER BY score DESC LIMIT $lim`,
      { vec: queryVec, lim: limit },
    );

    return rows
      .filter((r: any) => (r.score ?? 0) > 0.4)
      .map((r: any) => ({
        id: String(r.id),
        name: r.name ?? "",
        description: r.description ?? "",
        preconditions: r.preconditions,
        steps: Array.isArray(r.steps) ? r.steps : [],
        postconditions: r.postconditions,
        successCount: Number(r.successCount ?? 1),
        failureCount: Number(r.failureCount ?? 0),
        avgDurationMs: Number(r.avgDurationMs ?? 0),
        confidence: Number(r.confidence ?? 1.0),
        active: r.active !== false,
        score: r.score,
      }));
  } catch (e) {
    swallow.warn("skills:find", e);
    return [];
  }
}

/**
 * Format matched skills as a structured context block for the LLM.
 */
export function formatSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map((s) => {
    const total = s.successCount + s.failureCount;
    const rate = total > 0 ? `${s.successCount}/${total} successful` : "new";
    const stepsStr = s.steps
      .map((step, i) => `  ${i + 1}. [${step.tool}] ${step.description}`)
      .join("\n");
    return `### ${s.name} (${rate})\n${s.description}\n${s.preconditions ? `Pre: ${s.preconditions}\n` : ""}Steps:\n${stepsStr}${s.postconditions ? `\nPost: ${s.postconditions}` : ""}`;
  });

  return `\n<skill_context>\n[Previously successful procedures — adapt as needed, don't follow blindly]\n${lines.join("\n\n")}\n</skill_context>`;
}

/**
 * Record skill outcome when a retrieved skill is used in a turn.
 */
export async function recordSkillOutcome(
  skillId: string,
  success: boolean,
  durationMs: number,
  store: SurrealStore,
): Promise<void> {
  if (!store.isAvailable()) return;
  const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_]+$/;
  if (!RECORD_ID_RE.test(skillId)) return;

  try {
    const field = success ? "success_count" : "failure_count";
    assertRecordId(skillId);
    // Direct interpolation safe: assertRecordId validates format above
    await store.queryExec(
      `UPDATE ${skillId} SET
        ${field} += 1,
        avg_duration_ms = (avg_duration_ms * (success_count + failure_count - 1) + $dur) / (success_count + failure_count),
        last_used = time::now()`,
      { dur: durationMs },
    );
  } catch (e) { swallow("skills:non-critical", e); }
}

// --- Causal Chain -> Skill Graduation ---

/**
 * Promote recurring successful causal chains into reusable skills.
 * When 3+ successful chains of the same type exist, synthesize a skill.
 */
export async function graduateCausalToSkills(
  store: SurrealStore,
  embeddings: EmbeddingService,
  complete: CompleteFn,
): Promise<number> {
  if (!store.isAvailable()) return 0;

  try {
    const groups = await store.queryFirst<{ chain_type: string; cnt: number; descriptions: string[] }>(
      `SELECT chain_type, count() AS cnt, array::group(description) AS descriptions
       FROM causal_chain
       WHERE success = true AND confidence >= 0.7
       GROUP BY chain_type`,
    );

    let created = 0;

    for (const group of groups) {
      if (group.cnt < 3) continue;

      // Check if a skill already covers this chain type
      const existing = await store.queryFirst<{ id: string }>(
        `SELECT id FROM skill WHERE string::lowercase(name) CONTAINS string::lowercase($ct) LIMIT 1`,
        { ct: group.chain_type },
      );
      if (existing.length > 0) continue;

      const resp = await complete({
        system: `Synthesize a reusable procedure from recurring patterns. Generic — no specific file paths or variable names.`,
        messages: [{
          role: "user",
          content: `${group.cnt} successful "${group.chain_type}" patterns:\n${group.descriptions.slice(0, 8).join("\n")}`,
        }],
        outputFormat: { type: "json_schema", schema: skillSchema },
      });

      const text = resp.text;
      let parsed: ExtractedSkill;
      try { parsed = JSON.parse(text); } catch {
        const jsonMatch = text.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) continue;
        try { parsed = JSON.parse(jsonMatch[0]); } catch { continue; }
      }
      if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length === 0) continue;

      let skillEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { skillEmb = await embeddings.embed(`${parsed.name}: ${parsed.description}`); } catch (e) { swallow("skills:ok", e); }
      }

      const record: Record<string, unknown> = {
        name: String(parsed.name).slice(0, 100),
        description: String(parsed.description).slice(0, 200),
        preconditions: parsed.preconditions ? String(parsed.preconditions).slice(0, 200) : undefined,
        steps: parsed.steps.slice(0, 6).map((s) => ({
          tool: String(s.tool ?? "unknown"),
          description: String(s.description ?? "").slice(0, 200),
        })),
        postconditions: parsed.postconditions ? String(parsed.postconditions).slice(0, 200) : undefined,
        graduated_from: group.chain_type,
        confidence: 1.0,
        active: true,
      };
      if (skillEmb?.length) record.embedding = skillEmb;

      const rows = await store.queryFirst<{ id: string }>(
        `CREATE skill CONTENT $record RETURN id`,
        { record },
      );
      if (rows[0]?.id) {
        const gradSkillId = String(rows[0].id);
        await supersedeOldSkills(gradSkillId, skillEmb ?? [], store);
        // skill_uses_concept: skill → concept
        const skillDesc = `${parsed.name} ${parsed.description ?? ""}`;
        await linkToRelevantConcepts(gradSkillId, "skill_uses_concept", skillDesc, store, embeddings, "skills:graduate:concepts", 5, 0.65, skillEmb);
        created++;
      }
    }

    return created;
  } catch (e) {
    swallow.warn("skills:graduateCausal", e);
    return 0;
  }
}
