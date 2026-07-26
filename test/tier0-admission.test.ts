/**
 * Tier-0 admission: does the budget check blame the right entry, and is it
 * reachable from every path that changes tier-0 cost?
 *
 * Regression context: admission compared the drop set of `existing +
 * candidate` against nothing at all. Tier 0 can already be over budget when a
 * write arrives — cognitive-bootstrap.ts, hooks/profile.ts and soul.ts all
 * create tier-0 rows without passing through this tool — and in that state
 * every add was refused with a `would_evict` naming entries that had already
 * stopped loading. One pre-existing overflow closed tier 0 to writes forever,
 * with a reason that was not true. Separately, only `add` was checked, so the
 * same budget was bypassable by adding a short entry and updating it long.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createCoreMemoryToolDef,
  checkTier0Admission,
} from "../src/engine/tools/core-memory.js";
import {
  applyCoreBudgetVerbose,
  calcBudgets,
  getTier0BudgetChars,
  getTier1BudgetChars,
  DEFAULT_CONTEXT_WINDOW,
} from "../src/engine/graph-context.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import type { CoreMemoryEntry } from "../src/engine/surreal.js";

const TIER0_BUDGET = getTier0BudgetChars(calcBudgets(DEFAULT_CONTEXT_WINDOW));

function entry(id: string, priority: number, chars: number, tier = 0): CoreMemoryEntry {
  return { id, text: "x".repeat(chars), category: "rules", priority, tier, active: true };
}

/** A tier-0 set big enough that the renderer is already dropping entries. */
function overflowingSet(): CoreMemoryEntry[] {
  const rows: CoreMemoryEntry[] = [];
  for (let i = 0; i < 40; i++) rows.push(entry(`core_memory:pre${i}`, 60, 700));
  return rows;
}

function makeTool(rows: CoreMemoryEntry[], onUpdate?: (f: Record<string, unknown>) => void) {
  const session = new SessionState("s", "s");
  const store = {
    isAvailable: () => true,
    getAllCoreMemory: async (tier?: number) =>
      tier == null ? rows : rows.filter((r) => r.tier === tier),
    createCoreMemory: async () => "core_memory:new",
    updateCoreMemory: async (_id: string, fields: Record<string, unknown>) => {
      onUpdate?.(fields);
      return true;
    },
    deleteCoreMemory: async () => {},
  };
  const state = {
    store,
    embeddings: { isAvailable: () => false },
    config: {},
    onSessionRemoved: () => {},
  } as unknown as GlobalPluginState;
  (state as unknown as { getSession: () => SessionState }).getSession = () => session;
  return createCoreMemoryToolDef(state, session);
}

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;

describe("checkTier0Admission — pre-existing overflow is not blamed on the candidate", () => {
  it("does not refuse when every dropped entry was already being dropped", () => {
    const existing = overflowingSet();
    const baseline = applyCoreBudgetVerbose([...existing], TIER0_BUDGET);
    expect(baseline.dropped.length).toBeGreaterThan(0); // precondition: already broken

    // A p99 candidate sorts above the p60 incumbents, so it displaces nobody
    // that was still loading — it consumes slack the tail was never reaching.
    const v = checkTier0Admission(existing, entry("(pending admission)", 99, 20));
    expect(v.ok).toBe(true);
    expect(v.evicted).toEqual([]);
    // …but the pre-existing damage is still reported rather than hidden.
    expect(v.preExistingDropped.length).toBe(baseline.dropped.length);
  });

  it("still refuses when the candidate genuinely displaces a loading entry", () => {
    // Exactly fills the budget, so anything added must push someone out.
    const existing: CoreMemoryEntry[] = [];
    let used = 0;
    for (let i = 0; used + 706 <= TIER0_BUDGET; i++) {
      existing.push(entry(`core_memory:fit${i}`, 60, 700));
      used += 706;
    }
    const baseline = applyCoreBudgetVerbose([...existing], TIER0_BUDGET);
    expect(baseline.dropped).toEqual([]); // precondition: nothing dropped yet

    const v = checkTier0Admission(existing, entry("(pending admission)", 99, 700));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("would_evict");
    expect(v.evicted.length).toBeGreaterThan(0);
    expect(v.preExistingDropped).toEqual([]);
  });

  it("reports budget_full when the candidate cannot fit AFTER its per-item cap", () => {
    // A single oversized entry is never budget_full on its own — the per-item
    // cap truncates it to something that trivially fits. budget_full is only
    // reachable when the tier is genuinely full and the candidate sorts last.
    const rows: CoreMemoryEntry[] = [];
    let used = 0;
    while (used + 706 <= TIER0_BUDGET) {
      rows.push(entry(`core_memory:f${rows.length}`, 90, 700));
      used += 706;
    }
    const v = checkTier0Admission(rows, entry("(pending admission)", 10, 700));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("budget_full");
    expect(v.preExistingDropped).toEqual([]);
  });

  it("on update, does not double-count the row being replaced", () => {
    const existing = [entry("core_memory:a", 90, 2_000), entry("core_memory:b", 60, 700)];
    // Rewriting :a to the SAME size must be admissible — the old cost is gone.
    const v = checkTier0Admission(existing, entry("core_memory:a", 90, 2_000), "core_memory:a");
    expect(v.ok).toBe(true);
  });
});

describe("core_memory add — refusal wording matches what actually happened", () => {
  it("admits a small high-priority entry into an already-overflowing tier 0, and says so", async () => {
    const tool = makeTool(overflowingSet());
    const res = await tool.execute("t", { action: "add", tier: 0, text: "short rule", priority: 99 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:new");
  });

  it("names only newly-evicted entries, and flags pre-existing overflow separately", async () => {
    // 40 uniform entries against a budget that fits 31: 9 are already dropped.
    // A p100 add consumes one more slot, so exactly ONE eviction is new.
    const tool = makeTool(overflowingSet());
    const res = await tool.execute("t", {
      action: "add", tier: 0, text: "y".repeat(700), priority: 100,
    });
    const d = res!.details as { error: boolean; reason: string; evicted: unknown[] };
    expect(d.reason).toBe("would_evict");
    expect(d.evicted).toHaveLength(1);
    expect(textOf(res as never)).toContain("already over budget before this write");
  });
});

describe("core_memory update — routed through the same budget check", () => {
  it("lets a priority raise through — under two-pass admission it cannot evict", async () => {
    // Raising p50 -> p100 raises this entry's per-item CAP, but caps are only
    // paid out of leftover slack (pass 2), never out of another entry's
    // admission (pass 1). So the raise takes whatever room is spare and stops;
    // nobody is pushed out, and there is nothing to refuse. Before the
    // two-pass fix this same setup evicted the tail.
    const rows = [entry("core_memory:a", 50, 5_000)];
    let used = 803 + 6;
    while (used + 706 <= TIER0_BUDGET) {
      rows.push(entry(`core_memory:f${rows.length}`, 60, 700));
      used += 706;
    }
    expect(applyCoreBudgetVerbose([...rows], TIER0_BUDGET).dropped).toEqual([]);

    const written: Record<string, unknown>[] = [];
    const tool = makeTool(rows, (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:a", priority: 100 });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
    expect(written).toHaveLength(1);

    // And the raise still evicts nobody once applied.
    const after = rows.map((r) => (String(r.id) === "core_memory:a" ? { ...r, priority: 100 } : r));
    expect(applyCoreBudgetVerbose(after, TIER0_BUDGET).dropped).toEqual([]);
  });

  it("still refuses an update that moves a row INTO tier 0 when there is no room", async () => {
    // The one remaining way an update can cost tier 0 a whole admission slot.
    const rows: CoreMemoryEntry[] = [];
    let used = 0;
    while (used + 706 <= TIER0_BUDGET) {
      rows.push(entry(`core_memory:f${rows.length}`, 90, 700));
      used += 706;
    }
    rows.push(entry("core_memory:t1row", 10, 700, 1)); // currently tier 1

    const written: Record<string, unknown>[] = [];
    const tool = makeTool(rows, (f) => written.push(f));
    const res = await tool.execute("t", { action: "update", id: "core_memory:t1row", tier: 0 });
    expect((res!.details as { reason?: string }).reason).toBe("budget_full");
    expect(written).toHaveLength(0);
  });

  it("admits an oversized rewrite but the renderer still caps it", async () => {
    // Documents the real bound: the store keeps the full text, the injected
    // context never exceeds the per-item cap. An update is not an unbounded
    // way to blow the budget — it is an unguarded way to evict the tail.
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", {
      action: "update", id: "core_memory:a", text: "z".repeat(50_000),
    });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
    expect((written[0].text as string).length).toBe(50_000);
    const rendered = applyCoreBudgetVerbose([entry("core_memory:a", 100, 50_000)], TIER0_BUDGET);
    expect(rendered.kept[0].text.length).toBeLessThan(3_000);
  });

  it("allows a rewrite that stays inside the budget", async () => {
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", {
      action: "update", id: "core_memory:a", text: "z".repeat(1_500),
    });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
    expect((written[0].text as string).length).toBe(1_500);
  });

  it("does not block an update that moves a row OUT of tier 0", async () => {
    const written: Record<string, unknown>[] = [];
    const tool = makeTool([entry("core_memory:a", 100, 200)], (f) => written.push(f));
    const res = await tool.execute("t", {
      action: "update", id: "core_memory:a", text: "z".repeat(50_000), tier: 1,
    });
    expect((res!.details as { id?: string }).id).toBe("core_memory:a");
  });

  it("leaves a priority raise budget-checked too, not just text growth", async () => {
    // Raising priority raises the entry's own per-item cap, so it can grow the
    // rendered cost without the text changing at all.
    const rows = [entry("core_memory:a", 50, 5_000), entry("core_memory:b", 40, 700)];
    const v = checkTier0Admission(rows, { ...rows[0], priority: 100 }, "core_memory:a");
    expect(v.usedChars).toBeGreaterThan(
      applyCoreBudgetVerbose([...rows], TIER0_BUDGET).usedChars,
    );
  });
});

describe("tier 1 shares the priority-scaled cap deliberately", () => {
  it("gives a p100 session directive the same room a p100 tier-0 directive gets", () => {
    const t1 = applyCoreBudgetVerbose(
      [entry("core_memory:t1", 100, 5_000, 1)],
      getTier1BudgetChars(calcBudgets(DEFAULT_CONTEXT_WINDOW)),
    );
    const t0 = applyCoreBudgetVerbose([entry("core_memory:t0", 100, 5_000)], TIER0_BUDGET);
    expect(t1.kept[0].text.length).toBe(t0.kept[0].text.length);
    expect(t1.kept[0].text.length).toBeGreaterThan(803); // not the old flat cap
  });

  it("still holds each tier to its own separate budget", () => {
    expect(getTier1BudgetChars(calcBudgets(DEFAULT_CONTEXT_WINDOW)))
      .not.toBe(TIER0_BUDGET);
  });
});

// Silence unused-import lint if vi is not otherwise referenced.
void vi;
