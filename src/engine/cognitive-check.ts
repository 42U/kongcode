/**
 * Cognitive Check — Periodic reasoning over retrieved context.
 *
 * Fires every few turns to evaluate what was retrieved, produce behavioral
 * directives for the next turn, and grade retrieval quality with LLM-judged
 * relevance scores that feed back into ACAN training.
 *
 * Ported from kongbrain — per-session state via WeakMap, takes SurrealStore param.
 */

import type { CompleteFn, SessionState } from "./state.js";
import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { assertRecordId } from "./surreal.js";

// --- Types ---

export interface CognitiveDirective {
  type: "repeat" | "continuation" | "contradiction" | "noise" | "insight";
  target: string;
  instruction: string;
  priority: "high" | "medium" | "low";
}

export interface RetrievalGrade {
  id: string;
  relevant: boolean;
  reason: string;
  score: number;
  learned: boolean;
  resolved: boolean;
}

export interface UserPreference {
  observation: string;
  confidence: "high" | "medium";
}

export interface CognitiveCheckResult {
  directives: CognitiveDirective[];
  grades: RetrievalGrade[];
  sessionContinuity: "continuation" | "repeat" | "new_topic" | "tangent";
  preferences: UserPreference[];
}

export interface CognitiveCheckInput {
  sessionId: string;
  userQuery: string;
  responseText: string;
  retrievedNodes: { id: string; text: string; score: number; table: string }[];
  recentTurns: { role: string; text: string }[];
}

// --- Per-session state ---

interface CognitiveState {
  pendingDirectives: CognitiveDirective[];
  sessionContinuity: string;
  checkInFlight: boolean;
  suppressedNodeIds: Set<string>;
}

const sessionState = new WeakMap<SessionState, CognitiveState>();

function getState(session: SessionState): CognitiveState {
  let state = sessionState.get(session);
  if (!state) {
    state = {
      pendingDirectives: [],
      sessionContinuity: "new_topic",
      checkInFlight: false,
      suppressedNodeIds: new Set(),
    };
    sessionState.set(session, state);
  }
  return state;
}

// --- Constants ---

const DIRECTIVE_TYPES = new Set(["repeat", "continuation", "contradiction", "noise", "insight"]);
const PRIORITIES = new Set(["high", "medium", "low"]);
const CONTINUITY_TYPES = new Set(["continuation", "repeat", "new_topic", "tangent"]);
const VALID_RECORD_ID = /^[a-z_]+:[a-zA-Z0-9_]+$/;

// --- Public API ---

/** Returns true on turn 2, then every 5 turns (2, 7, 12, 17...). False if in-flight or retrieval skipped. */
export function shouldRunCheck(turnCount: number, session: SessionState): boolean {
  const state = getState(session);
  if (state.checkInFlight) return false;
  if (turnCount < 2) return false;
  // Skip when retrieval is disabled — no context to evaluate
  if (session.currentConfig?.skipRetrieval) return false;
  return turnCount === 2 || (turnCount - 2) % 5 === 0;
}

export function getPendingDirectives(session: SessionState): CognitiveDirective[] {
  return getState(session).pendingDirectives;
}

export function clearPendingDirectives(session: SessionState): void {
  getState(session).pendingDirectives = [];
}

export function getSessionContinuity(session: SessionState): string {
  return getState(session).sessionContinuity;
}

export function getSuppressedNodeIds(session: SessionState): ReadonlySet<string> {
  return getState(session).suppressedNodeIds;
}

/** Fire-and-forget LLM call. Stores directives, writes grades to DB. */
export async function runCognitiveCheck(
  params: CognitiveCheckInput,
  session: SessionState,
  store: SurrealStore,
  complete: CompleteFn,
): Promise<void> {
  const state = getState(session);
  if (state.checkInFlight) return;
  if (params.retrievedNodes.length === 0) return;

  state.checkInFlight = true;
  try {
    // Build input sections
    const sections: string[] = [];
    sections.push(`[QUERY] ${params.userQuery.slice(0, 500)}`);
    sections.push(`[RESPONSE] ${params.responseText.slice(0, 500)}`);

    const nodeLines = params.retrievedNodes
      .slice(0, 20)
      .map(n => `- ${n.id} (score: ${n.score.toFixed(2)}): ${n.text.slice(0, 150)}`);
    sections.push(`[RETRIEVED]\n${nodeLines.join("\n")}`);

    if (params.recentTurns.length > 0) {
      const trajectory = params.recentTurns
        .slice(-6)
        .map(t => `[${t.role}] ${(t.text ?? "").slice(0, 200)}`)
        .join("\n");
      sections.push(`[TRAJECTORY]\n${trajectory}`);
    }

    const cogCheckSchema = {
      type: "object" as const,
      properties: {
        directives: { type: "array", items: { type: "object" } },
        grades: { type: "array", items: { type: "object" } },
        sessionContinuity: { type: "string", enum: ["repeat", "continuation", "new_topic", "tangent"] },
        preferences: { type: "array", items: { type: "object" } },
      },
      required: ["directives", "grades", "sessionContinuity", "preferences"],
    };

    const response = await complete({
      system: `Grade retrieved context. directives: max 3, types: repeat|continuation|contradiction|noise|insight. grades: one per node, learned=true only if CORRECTION already followed unprompted. preferences: max 2, [] if none.`,
      messages: [{
        role: "user",
        content: sections.join("\n\n"),
      }],
      outputFormat: { type: "json_schema", schema: cogCheckSchema },
    });

    const responseText = response.text;

    const result = parseCheckResponse(responseText);
    if (!result) return;

    // Store directives for next turn's context formatting
    state.pendingDirectives = result.directives;
    state.sessionContinuity = result.sessionContinuity;

    // Write grades to DB
    if (result.grades.length > 0) {
      await applyRetrievalGrades(result.grades, params.sessionId, store);
    }

    // Correction importance adjustment based on behavioral compliance
    const correctionGrades = result.grades.filter(g => g.id.startsWith("memory:") && g.relevant);
    for (const g of correctionGrades) {
      if (g.learned) {
        // Agent followed the correction unprompted — decay toward background (floor 3)
        assertRecordId(g.id);
        // Direct interpolation safe: assertRecordId validates format above
        await store.queryExec(
          `UPDATE ${g.id} SET importance = math::max([3, (importance ?? 5) - 2])`,
        ).catch(e => swallow.warn("cognitive-check:correctionDecay", e));
      } else {
        // Correction was relevant but agent ignored it — reinforce (cap 9)
        assertRecordId(g.id);
        // Direct interpolation safe: assertRecordId validates format above
        await store.queryExec(
          `UPDATE ${g.id} SET importance = math::min([9, (importance ?? 5) + 1])`,
        ).catch(e => swallow.warn("cognitive-check:correctionReinforce", e));
      }
    }

    // Store high-confidence user preferences as session-pinned core memory
    const highConfPrefs = result.preferences.filter(p => p.confidence === "high");
    for (const pref of highConfPrefs) {
      await store.createCoreMemory(
        `[USER PREFERENCE] ${pref.observation}`,
        "preference", 7, 1, params.sessionId,
      ).catch(e => swallow.warn("cognitive-check:preference", e));
    }

    // Noise suppression — prevent re-retrieval of irrelevant nodes this session
    for (const g of result.grades) {
      if (!g.relevant && g.score < 0.3) {
        state.suppressedNodeIds.add(g.id);
      }
    }
    for (const d of result.directives) {
      if (d.type === "noise" && VALID_RECORD_ID.test(d.target)) {
        state.suppressedNodeIds.add(d.target);
      }
    }

    // Mid-session resolution — mark addressed memories immediately
    const resolvedGrades = result.grades.filter(g => g.resolved && g.id.startsWith("memory:"));
    for (const g of resolvedGrades) {
      assertRecordId(g.id);
      // Direct interpolation safe: assertRecordId validates format above
      await store.queryExec(
        `UPDATE ${g.id} SET status = 'resolved', resolved_at = time::now(), resolved_by = $sid`,
        { sid: params.sessionId },
      ).catch(e => swallow.warn("cognitive-check:resolve", e));
    }
  } catch (e) {
    swallow.warn("cognitive-check:run", e);
  } finally {
    state.checkInFlight = false;
  }
}

// --- Response parsing ---

export function parseCheckResponse(text: string): CognitiveCheckResult | null {
  // Strip markdown fences if present
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  const jsonMatch = stripped.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  let raw: any;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    try {
      raw = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, "$1"));
    } catch { return null; }
  }

  // Validate directives
  const directives: CognitiveDirective[] = [];
  if (Array.isArray(raw.directives)) {
    for (const d of raw.directives.slice(0, 3)) {
      if (!d.type || !d.target || !d.instruction) continue;
      if (!DIRECTIVE_TYPES.has(d.type)) continue;
      directives.push({
        type: d.type,
        target: String(d.target).slice(0, 100),
        instruction: String(d.instruction).slice(0, 200),
        priority: PRIORITIES.has(d.priority) ? d.priority : "medium",
      });
    }
  }

  // Validate grades
  const grades: RetrievalGrade[] = [];
  if (Array.isArray(raw.grades)) {
    for (const g of raw.grades.slice(0, 30)) {
      if (!g.id || typeof g.relevant !== "boolean") continue;
      if (!VALID_RECORD_ID.test(g.id)) continue;
      grades.push({
        id: String(g.id),
        relevant: Boolean(g.relevant),
        reason: String(g.reason ?? "").slice(0, 150),
        score: Math.max(0, Math.min(1, Number(g.score) || 0)),
        learned: g.learned === true,
        resolved: g.resolved === true,
      });
    }
  }

  // Validate preferences
  const preferences: UserPreference[] = [];
  if (Array.isArray(raw.preferences)) {
    for (const p of raw.preferences.slice(0, 2)) {
      if (!p.observation) continue;
      if (p.confidence !== "high" && p.confidence !== "medium") continue;
      preferences.push({
        observation: String(p.observation).slice(0, 200),
        confidence: p.confidence,
      });
    }
  }

  const sessionContinuity = CONTINUITY_TYPES.has(raw.sessionContinuity)
    ? raw.sessionContinuity
    : "new_topic";

  return { directives, grades, sessionContinuity, preferences };
}

// --- Grade application ---

async function applyRetrievalGrades(
  grades: RetrievalGrade[],
  sessionId: string,
  store: SurrealStore,
): Promise<void> {
  for (const grade of grades) {
    try {
      // Find the most recent retrieval outcome for this memory+session
      const row = await store.queryFirst<{ id: string }>(
        `SELECT id, created_at FROM retrieval_outcome
          WHERE memory_id = $id AND session_id = $sid
          ORDER BY created_at DESC LIMIT 1`,
        { id: grade.id, sid: sessionId },
      );
      if (row?.[0]?.id) {
        const rid = String(row[0].id);
        assertRecordId(rid);
        // Direct interpolation safe: assertRecordId validates format above
        await store.queryExec(
          `UPDATE ${rid} SET llm_relevance = $score, llm_relevant = $relevant, llm_reason = $reason`,
          { score: grade.score, relevant: grade.relevant, reason: grade.reason },
        );
      }
      // Feed relevance score into the utility cache — drives WMR provenUtility scoring
      await store.updateUtilityCache(grade.id, grade.score).catch(e =>
        swallow.warn("cognitive-check:utilityCache", e));
    } catch (e) {
      swallow.warn("cognitive-check:applyGrade", e);
    }
  }
}
