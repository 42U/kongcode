/**
 * Tier-0 core memory: budget accounting, priority-scaled per-item caps, and
 * observable loss.
 *
 * Regression context: a flat 800-char per-item cap silently truncated the
 * HIGHEST-priority directives, because importance correlates with length and
 * truncation eats the tail, which is where a rule's concrete specifics live.
 * On a real install, 8 of 25 tier-0 rules were being cut at exactly 803 chars
 * every turn with no signal to anyone, including a deploy-path rule and a
 * trading-bot safety floor that was severed before its own numeric value.
 */
import { describe, it, expect } from "vitest";
import { applyCoreBudgetVerbose, calcBudgets, getTier0BudgetChars, DEFAULT_CONTEXT_WINDOW } from "../src/engine/graph-context.js";
import type { CoreMemoryEntry } from "../src/engine/surreal.js";

function entry(id: string, priority: number, chars: number): CoreMemoryEntry {
  return {
    id,
    text: "x".repeat(chars),
    category: "rules",
    priority,
    tier: 0,
    active: true,
  };
}

const BIG_BUDGET = 1_000_000;

describe("tier-0 per-item cap scales with priority", () => {
  it("does not truncate a high-priority directive that the old flat 800 cap would have cut", () => {
    const r = applyCoreBudgetVerbose([entry("rule:critical", 100, 2000)], BIG_BUDGET);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].text).toHaveLength(2000);
    expect(r.kept[0].text.endsWith("...")).toBe(false);
    expect(r.truncated).toHaveLength(0);
  });

  it("still truncates a default-priority entry at the base cap", () => {
    const r = applyCoreBudgetVerbose([entry("note:ordinary", 50, 2000)], BIG_BUDGET);
    expect(r.kept[0].text).toHaveLength(803); // 800 + "..."
    expect(r.truncated).toEqual([
      { id: "note:ordinary", priority: 50, from: 2000, to: 800 },
    ]);
  });

  it("gives a p100 entry strictly more room than a p50 entry", () => {
    const hi = applyCoreBudgetVerbose([entry("hi", 100, 5000)], BIG_BUDGET).kept[0].text.length;
    const lo = applyCoreBudgetVerbose([entry("lo", 50, 5000)], BIG_BUDGET).kept[0].text.length;
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBe(803);
    expect(hi).toBe(2403); // 800 * 3 + "..."
  });

  it("never shrinks the guaranteed floor below the base cap", () => {
    for (const p of [0, 25, 50]) {
      const r = applyCoreBudgetVerbose([entry(`p${p}`, p, 5000)], BIG_BUDGET);
      expect(r.kept[0].text).toHaveLength(803);
    }
  });
});

describe("tier-0 loss is reported, not silent", () => {
  it("reports entries dropped because the budget was exhausted", () => {
    const entries = [entry("a", 100, 400), entry("b", 90, 400), entry("c", 10, 400)];
    const r = applyCoreBudgetVerbose(entries, 900);
    expect(r.kept.map((e) => e.id)).toEqual(["a", "b"]);
    expect(r.dropped).toEqual([{ id: "c", priority: 10, chars: 400 }]);
  });

  it("reports truncation separately from dropping", () => {
    const r = applyCoreBudgetVerbose([entry("long", 50, 1200), entry("short", 40, 50)], BIG_BUDGET);
    expect(r.dropped).toHaveLength(0);
    expect(r.truncated.map((t) => t.id)).toEqual(["long"]);
  });

  it("accounts usage against the budget it was given", () => {
    const r = applyCoreBudgetVerbose([entry("a", 50, 100)], 5000);
    expect(r.budgetChars).toBe(5000);
    expect(r.usedChars).toBe(106); // text + 6 chars of framing
  });

  it("keeps nothing and reports everything when the budget is zero", () => {
    const r = applyCoreBudgetVerbose([entry("a", 100, 10), entry("b", 50, 10)], 0);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("tier-0 budget is large enough that a count cap is the wrong guard", () => {
  it("fits far more than 25 realistically-sized directives", () => {
    // The removed guard refused a 26th entry regardless of size. At the real
    // default budget, 25 average directives use only a fraction of it.
    const budget = getTier0BudgetChars(calcBudgets(DEFAULT_CONTEXT_WINDOW));
    const twentyFive = Array.from({ length: 25 }, (_, i) => entry(`r${i}`, 50, 560));
    const r = applyCoreBudgetVerbose(twentyFive, budget);
    expect(r.kept).toHaveLength(25);
    expect(r.dropped).toHaveLength(0);
    expect(r.usedChars).toBeLessThan(budget);
  });
});
