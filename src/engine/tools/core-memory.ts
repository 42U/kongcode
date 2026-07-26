/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from laqrumbrain with SurrealStore injection.
 */

import { Type } from "@sinclair/typebox";
import type { GlobalPluginState, SessionState } from "../state.js";
import { stripStructuralTags } from "../sanitize.js";
import { log } from "../log.js";
import type { CoreMemoryEntry } from "../surreal.js";
import {
  calcBudgets,
  getTier0BudgetChars,
  applyCoreBudgetVerbose,
  DEFAULT_CONTEXT_WINDOW,
} from "../graph-context.js";

const TIER0_MAX_PER_SESSION = 5;
const tier0WritesPerSession = new Map<string, number>();

/**
 * Per-state guard so we wire the session-removed cleanup hook exactly once
 * per {@link GlobalPluginState} instance. A WeakSet (not a boolean) so that
 * if the module survives a re-import while a new state is constructed in
 * tests, each fresh state still gets its callback registered; and so old
 * state instances are eligible for GC without leaking entries here.
 *
 * The registered callback deletes the per-session entry from
 * {@link tier0WritesPerSession} on SessionEnd / stale-session reaping, so
 * Claude Code's `sessionId` reuse across SessionEnd→SessionStart cycles no
 * longer bleeds the prior cycle's write count into a fresh session (which
 * was silently capping new tier-0 writes).
 *
 * Known dev-only limitation: under hot-reload (vite-node, ts-node-dev, etc.)
 * this module can be re-imported while the same {@link GlobalPluginState}
 * instance persists. The freshly-loaded module gets a new (empty)
 * `hookedStates` and a new (empty) `tier0WritesPerSession`, so the same
 * state gets a SECOND `onSessionRemoved` registration pointing at the new
 * map. Both registrations fire on session removal; the old registration's
 * `.delete()` against the old map is a no-op (the map is unreachable from
 * the new module's code) so the only cost is one wasted callback firing
 * per session-end per reload generation. This does not affect production —
 * the daemon does not hot-reload — and not in tests, which fully discard
 * the state between runs. We accept this rather than wire a deregister
 * disposer through to module unload, which has no reliable hook in Node.
 */
const hookedStates = new WeakSet<GlobalPluginState>();

function ensureSessionRemovedHook(state: GlobalPluginState): void {
  if (hookedStates.has(state)) return;
  hookedStates.add(state);
  state.onSessionRemoved((sessionId) => {
    tier0WritesPerSession.delete(sessionId);
  });
}

/** Sentinel id for an entry that is not in the store yet. Real ids are always
 *  `core_memory:<id>`, so this cannot collide with one. */
const CANDIDATE_ID = "(pending admission)";

export interface Tier0AdmissionResult {
  ok: boolean;
  reason?: "budget_full" | "would_evict";
  /** Entries this candidate would newly push out of the budget. */
  evicted: { id: string; priority: number; chars: number }[];
  /** Entries that were ALREADY over budget before this write was attempted.
   *  Reported so the operator can act on them, never blamed on the candidate. */
  preExistingDropped: { id: string; priority: number; chars: number }[];
  usedChars: number;
  budgetChars: number;
}

/**
 * Test a candidate tier-0 entry against the SAME character budget the renderer
 * enforces (graph-context `applyCoreBudget`), rather than a separate entry count.
 *
 * The candidate is only blamed for evictions it actually causes. Tier 0 can
 * already be over budget when this runs — `cognitive-bootstrap.ts`,
 * `hooks/profile.ts` and `soul.ts` all create tier-0 rows without passing
 * through this tool — so the drop set is diffed against a baseline computed
 * WITHOUT the candidate. Skipping that diff means a single pre-existing
 * overflow makes every later write fail with a `would_evict` naming entries
 * that had already stopped loading, and tier 0 closes to writes permanently.
 *
 * @param existing    active tier-0 entries, as the store returns them
 * @param candidate   the entry being added, or the post-update form of one
 * @param replacingId on update, the id whose current cost the candidate
 *                    replaces; omitted for a fresh add
 */
export function checkTier0Admission(
  existing: CoreMemoryEntry[],
  candidate: CoreMemoryEntry,
  replacingId?: string,
): Tier0AdmissionResult {
  const budgetChars = getTier0BudgetChars(calcBudgets(DEFAULT_CONTEXT_WINDOW));
  const byPriorityDesc = (a: CoreMemoryEntry, b: CoreMemoryEntry) =>
    (b.priority ?? 50) - (a.priority ?? 50);

  // Incumbents = what remains alongside the candidate. On update the row being
  // rewritten drops out so its OLD cost is not counted on top of its new one.
  // String() every id before comparing. SurrealStore.queryFirst does no id
  // normalization, so `e.id` is a surrealdb RecordId OBJECT, not a string — a
  // bare `===` against an id string is always false and the comparison silently
  // matches nothing. (createCoreMemory and archiveOldTurns already String() for
  // this reason.) Mocked tests using plain-string ids cannot catch it.
  const incumbents = replacingId
    ? existing.filter((e) => String(e.id) !== String(replacingId))
    : [...existing];

  // Baseline: what the renderer drops today, candidate absent. Array sort is
  // stable, so equal priorities keep store order and the candidate — appended
  // last — never outranks an incumbent it ties with.
  const baseline = applyCoreBudgetVerbose([...incumbents].sort(byPriorityDesc), budgetChars);
  const alreadyDropped = new Set(baseline.dropped.map((d) => String(d.id)));

  const fit = applyCoreBudgetVerbose([...incumbents, candidate].sort(byPriorityDesc), budgetChars);
  const base = {
    preExistingDropped: baseline.dropped,
    usedChars: fit.usedChars,
    budgetChars,
  };

  const candidateId = String(candidate.id);
  if (fit.dropped.some((d) => String(d.id) === candidateId)) {
    return { ok: false, reason: "budget_full" as const, evicted: [], ...base };
  }
  // Greedy fill in priority order is monotonic — inserting the candidate can
  // only ever grow the drop set — so this difference is exactly what IT displaced.
  const evicted = fit.dropped.filter(
    (d) => String(d.id) !== candidateId && !alreadyDropped.has(String(d.id)),
  );
  if (evicted.length) {
    return { ok: false, reason: "would_evict" as const, evicted, ...base };
  }
  return { ok: true, evicted: [], ...base };
}

/** Trailing sentence distinguishing "you caused this" from "this was already
 *  broken when you got here". Silence on a pre-existing overflow is what let
 *  the old count cap look correct while entries were being dropped anyway. */
function preExistingNote(v: Tier0AdmissionResult): string {
  if (!v.preExistingDropped.length) return "";
  const n = v.preExistingDropped.length;
  const ids = v.preExistingDropped.map((d) => `${d.id} (p${d.priority})`).join("; ");
  return ` NOTE: tier 0 was already over budget before this write — ${n} ` +
    `entr${n === 1 ? "y is" : "ies are"} already not loading: ${ids}. That is not ` +
    `caused by this entry; shorten or deactivate them to recover the space.`;
}

function tier0Refusal(
  v: Tier0AdmissionResult,
  candidate: CoreMemoryEntry,
  incumbents: CoreMemoryEntry[],
  subject: "this entry" | "this update",
) {
  if (v.reason === "budget_full") {
    const weakest = [...incumbents]
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
      .slice(0, 3)
      .map((e) => `${e.id} (p${e.priority}, ${e.text.length} chars)`)
      .join("; ");
    return {
      content: [{ type: "text" as const, text:
        `Tier 0 budget full: ${v.usedChars}/${v.budgetChars} chars across ${incumbents.length} entries. ` +
        `${subject[0].toUpperCase()}${subject.slice(1)} (p${candidate.priority}, ${candidate.text.length} chars) ` +
        `does not fit. Shorten it, raise its priority, or deactivate one of the lowest-priority ` +
        `entries: ${weakest}.` + preExistingNote(v) }],
      details: { error: true, reason: "budget_full", usedChars: v.usedChars, budgetChars: v.budgetChars },
    };
  }
  const n = v.evicted.length;
  const list = v.evicted.map((d) => `${d.id} (p${d.priority})`).join("; ");
  return {
    content: [{ type: "text" as const, text:
      `Refused: ${subject} (p${candidate.priority}) would push ${n} lower-priority ` +
      `entr${n === 1 ? "y" : "ies"} out of the tier-0 budget, and ${n === 1 ? "it" : "they"} would ` +
      `silently stop loading: ${list}. Deactivate ${n === 1 ? "it" : "them"} explicitly first, or ` +
      `lower this entry's priority.` + preExistingNote(v) }],
    details: { error: true, reason: "would_evict", evicted: v.evicted },
  };
}

const coreMemorySchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("deactivate"),
  ], { description: "Action to perform on core memory." }),
  tier: Type.Optional(Type.Number({ description: "Filter by tier (0=always loaded, 1=session-pinned). Default: list all." })),
  category: Type.Optional(Type.String({ description: "Category (identity/rules/tools/operations/general)." })),
  text: Type.Optional(Type.String({ description: "Text content for add/update actions." })),
  priority: Type.Optional(Type.Number({ description: "Priority for add/update (higher=loaded first). Default: 50." })),
  id: Type.Optional(Type.String({ description: "Record ID for update/deactivate (e.g. core_memory:abc123)." })),
  session_id: Type.Optional(Type.String({ description: "Session ID for Tier 1 entries." })),
});

export function createCoreMemoryToolDef(state: GlobalPluginState, session: SessionState) {
  // Idempotent — registers the session-removed cleanup callback exactly
  // once per GlobalPluginState instance. Safe to call on every toolDef
  // construction (and the factory IS called per session/toolset build).
  ensureSessionRemovedHook(state);
  return {
    name: "core_memory",
    label: "Core Memory",
    description: "Manage always-loaded core directives (Tier 0) and session-pinned context (Tier 1). Tier 0 entries are present in EVERY turn — use for identity, rules, tool patterns. Tier 1 entries are pinned for the current session.",
    parameters: coreMemorySchema,
    execute: async (_toolCallId: string, params: {
      action: "list" | "add" | "update" | "deactivate";
      tier?: number; category?: string; text?: string;
      priority?: number; id?: string; session_id?: string;
    }) => {
      const { store } = state;
      if (!store.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Database unavailable." }], details: null };
      }

      try {
        switch (params.action) {
          case "list": {
            const entries = await store.getAllCoreMemory(params.tier);
            if (entries.length === 0) {
              return { content: [{ type: "text" as const, text: "No core memory entries found." }], details: null };
            }
            const formatted = entries.map((e, i) => {
              const sid = e.session_id ? ` session:${e.session_id}` : "";
              return `${i + 1}. [T${e.tier}/${e.category}/p${e.priority}${sid}] ${e.id}\n   ${e.text.slice(0, 120)}`;
            }).join("\n\n");
            return {
              content: [{ type: "text" as const, text: `${entries.length} core memory entries:\n\n${formatted}` }],
              details: { count: entries.length },
            };
          }

          case "add": {
            if (!params.text) {
              return { content: [{ type: "text" as const, text: "Error: 'text' is required for add action." }], details: null };
            }
            const tier = params.tier ?? 0;
            const sanitized = stripStructuralTags(params.text);
            if (tier === 0) {
              const sessionWrites = tier0WritesPerSession.get(session.sessionId) ?? 0;
              if (sessionWrites >= TIER0_MAX_PER_SESSION) {
                return {
                  content: [{ type: "text" as const, text: `Tier 0 write limit reached (${TIER0_MAX_PER_SESSION}/session). Use update to modify existing entries or deactivate unused ones first.` }],
                  details: { error: true, reason: "session_rate_limit" },
                };
              }
              // Admit against the SAME character budget the renderer enforces,
              // not a separate entry count. A count cap governs the wrong unit:
              // entries vary by an order of magnitude in size, so N entries can
              // sit well under budget (and be wrongly refused) or over it (and
              // be silently dropped at render time).
              const existing = await store.getAllCoreMemory(0);
              const candidate: CoreMemoryEntry = {
                id: CANDIDATE_ID,
                text: sanitized,
                category: stripStructuralTags(params.category ?? "general"),
                priority: params.priority ?? 50,
                tier: 0,
                active: true,
              };
              const verdict = checkTier0Admission(existing, candidate);
              if (!verdict.ok) return tier0Refusal(verdict, candidate, existing, "this entry");
              if (verdict.preExistingDropped.length) {
                log.warn(`[core-memory] tier 0 is over budget: ${verdict.preExistingDropped.length} ` +
                  `entr${verdict.preExistingDropped.length === 1 ? "y" : "ies"} not loading ` +
                  `(${verdict.preExistingDropped.map((d) => d.id).join(", ")})`);
              }
              log.warn(`[core-memory] tier-0 write: "${sanitized.slice(0, 120)}..." (session=${session.sessionId})`);
            }
            const sid = tier === 1 ? (params.session_id ?? session.sessionId) : undefined;
            const id = await store.createCoreMemory(
              sanitized,
              params.category ?? "general",
              params.priority ?? 50,
              tier,
              sid,
            );
            if (!id) {
              return {
                content: [{ type: "text" as const, text: "FAILED: Core memory entry was not created." }],
                details: { error: true },
              };
            }
            if (tier === 0) {
              tier0WritesPerSession.set(session.sessionId, (tier0WritesPerSession.get(session.sessionId) ?? 0) + 1);
            }
            // Invalidate cached section so updated content re-injects next turn
            session.injectedSections.delete(tier === 0 ? "tier0" : "tier1");
            return {
              content: [{ type: "text" as const, text: `Created core memory: ${id} (tier ${tier}, ${params.category ?? "general"}, p${params.priority ?? 50})` }],
              details: { id },
            };
          }

          case "update": {
            if (!params.id) {
              return { content: [{ type: "text" as const, text: "Error: 'id' is required for update action." }], details: null };
            }
            // Budget-check BEFORE writing. An update changes tier-0 cost in
            // three ways the `add` guard never sees: growing an entry's text,
            // raising its priority (which raises that entry's own per-item cap,
            // so cost grows with the text untouched), and moving a row INTO
            // tier 0. Any of them can push other entries out of the budget,
            // and those entries then stop loading with no signal to anyone.
            //
            // The per-item cap bounds how far a single entry can grow, so this
            // was never an unbounded hole — an oversized update is truncated at
            // render, not admitted whole. It was an unguarded one: the eviction
            // it causes in the tail is silent, which is the same failure the
            // add-side check exists to prevent.
            const all = await store.getAllCoreMemory();
            // String(): rows carry RecordId objects, so `e.id === params.id`
            // is always false and this guard would never fire (v0.8.5 fix —
            // the check shipped dead because its tests mocked string ids).
            const current = all.find((e) => String(e.id) === params.id);
            const newText = params.text !== undefined ? stripStructuralTags(params.text) : current?.text;
            const newTier = params.tier ?? current?.tier;
            if (current && newTier === 0 && newText !== undefined) {
              const tier0 = all.filter((e) => e.tier === 0);
              const candidate: CoreMemoryEntry = {
                ...current,
                text: newText,
                category: params.category ?? current.category,
                priority: params.priority ?? current.priority ?? 50,
                tier: 0,
              };
              const verdict = checkTier0Admission(tier0, candidate, current.id);
              if (!verdict.ok) {
                return tier0Refusal(
                  verdict, candidate, tier0.filter((e) => e.id !== current.id), "this update",
                );
              }
            }
            const fields: Record<string, unknown> = {};
            if (params.text !== undefined) {
              fields.text = newText;
              log.warn(`[core-memory] update ${params.id}: "${String(fields.text).slice(0, 120)}..." (session=${session.sessionId})`);
            }
            if (params.category !== undefined) fields.category = stripStructuralTags(params.category);
            if (params.priority !== undefined) fields.priority = params.priority;
            if (params.tier !== undefined) fields.tier = params.tier;
            const updated = await store.updateCoreMemory(params.id, fields);
            if (!updated) {
              return {
                content: [{ type: "text" as const, text: `FAILED: Could not update ${params.id}.` }],
                details: { error: true },
              };
            }
            // Invalidate both tiers — update may have changed the tier
            session.injectedSections.delete("tier0");
            session.injectedSections.delete("tier1");
            return {
              content: [{ type: "text" as const, text: `Updated core memory: ${params.id}` }],
              details: { id: params.id },
            };
          }

          case "deactivate": {
            if (!params.id) {
              return { content: [{ type: "text" as const, text: "Error: 'id' is required for deactivate action." }], details: null };
            }
            await store.deleteCoreMemory(params.id);
            // Invalidate both tiers so removal is reflected next turn
            session.injectedSections.delete("tier0");
            session.injectedSections.delete("tier1");
            return {
              content: [{ type: "text" as const, text: `Deactivated core memory: ${params.id}` }],
              details: { id: params.id },
            };
          }
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Core memory operation failed: ${err}` }], details: null };
      }
    },
  };
}
