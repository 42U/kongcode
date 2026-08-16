/**
 * Tests for the PR #22 follow-up hardening of the soul_evolve pipeline.
 *
 * PR #22 ("stop soul_evolve from silently dropping earned_values") fixed the
 * observed drop — bare-string earned_values coerced to empty objects and
 * filtered out — but left the deeper hazards open:
 *
 *   1. It embedded `soulSchema` (all four sections `required`) into a prompt
 *      whose contract is "return ONLY changed sections / return {}".
 *   2. reviseSoul REPLACES a section wholesale, so a delta-shaped return
 *      (only the new entries — exactly the shape the bare-string incident
 *      proved agents produce) would WIPE the section's stored entries once
 *      the bare-string leniency let it land.
 *   3. The same silent-drop coercion class survived in soul_generate and in
 *      the other three soul_evolve sections.
 *   4. An evolved soul was never re-seeded into Tier-0 core memory, so
 *      revisions stayed invisible to the every-turn context.
 *
 * These tests pin the fixes: partial schema in the payload, delta-guard
 * merge in the commit handler, tolerant per-section coercion, junk guard,
 * and the post-revision core-memory re-seed.
 */

import { describe, it, expect, vi } from "vitest";
import * as pendingWork from "../src/tools/pending-work.js";

const t = (pendingWork as any).__test__;
const coerceStringSection = t.coerceStringSection as (raw: unknown) => string[];
const coerceEmotionalDimensions = t.coerceEmotionalDimensions as (raw: unknown, now: string) => { dimension: string; description: string; adopted_at: string }[];
const coerceEarnedValues = t.coerceEarnedValues as (raw: unknown) => { value: string; grounded_in: string }[];
const mergeSoulSection = t.mergeSoulSection as (section: string, current: unknown[], submitted: unknown[]) => unknown[];

// ── Pure coercion helpers ────────────────────────────────────────────────────

describe("coerceEarnedValues", () => {
  it("accepts bare strings as {value, grounded_in: ''} (PR #22)", () => {
    expect(coerceEarnedValues(["thoroughness pays off"]))
      .toEqual([{ value: "thoroughness pays off", grounded_in: "" }]);
  });

  it("maps alias keys (name→value, evidence→grounded_in)", () => {
    expect(coerceEarnedValues([{ name: "accuracy", evidence: "caught 3 bugs" }]))
      .toEqual([{ value: "accuracy", grounded_in: "caught 3 bugs" }]);
  });

  it("wraps a single non-array object instead of throwing", () => {
    expect(coerceEarnedValues({ value: "honesty", grounded_in: "user trust" }))
      .toEqual([{ value: "honesty", grounded_in: "user trust" }]);
  });

  it("drops junk apology strings but keeps short legit values", () => {
    expect(coerceEarnedValues(["Empty transcript, nothing to extract", "rigor"]))
      .toEqual([{ value: "rigor", grounded_in: "" }]);
  });

  it("drops entries with no derivable value", () => {
    expect(coerceEarnedValues([42, null, {}, { grounded_in: "orphan" }])).toEqual([]);
  });
});

describe("coerceStringSection", () => {
  it("keeps strings including short ones and trims", () => {
    expect(coerceStringSection(["direct", "  concise "])).toEqual(["direct", "concise"]);
  });

  it("accepts objects carrying an obvious text field", () => {
    expect(coerceStringSection([{ observation: "I over-plan" }, { text: "I verify claims" }]))
      .toEqual(["I over-plan", "I verify claims"]);
  });

  it("drops non-text entries and junk", () => {
    expect(coerceStringSection(["good", 42, null, { nested: true }, "no transcript data available"]))
      .toEqual(["good"]);
  });

  it("wraps a single bare string", () => {
    expect(coerceStringSection("methodical")).toEqual(["methodical"]);
  });
});

describe("coerceEmotionalDimensions", () => {
  const NOW = "2026-08-16T00:00:00.000Z";

  it("accepts bare strings as a dimension with empty description", () => {
    expect(coerceEmotionalDimensions(["curiosity"], NOW))
      .toEqual([{ dimension: "curiosity", description: "", adopted_at: NOW }]);
  });

  it("maps alias keys (name→dimension, rationale→description)", () => {
    expect(coerceEmotionalDimensions([{ name: "patience", rationale: "waited for tests" }], NOW))
      .toEqual([{ dimension: "patience", description: "waited for tests", adopted_at: NOW }]);
  });

  it("drops entries with no dimension", () => {
    expect(coerceEmotionalDimensions([{ description: "orphan" }, 7], NOW)).toEqual([]);
  });
});

// ── Delta-guard merge ────────────────────────────────────────────────────────

describe("mergeSoulSection", () => {
  const current = [
    { value: "correctness over speed", grounded_in: "caught a bug by double-checking" },
    { value: "honesty about uncertainty", grounded_in: "user corrections" },
  ];

  it("APPENDS when the submission has zero overlap with a non-empty section (delta-shaped)", () => {
    const submitted = [{ value: "verify before claiming done", grounded_in: "" }];
    const merged = mergeSoulSection("earned_values", current, submitted);
    expect(merged).toHaveLength(3);
    expect(merged.slice(0, 2)).toEqual(current);
    expect(merged[2]).toEqual(submitted[0]);
  });

  it("REPLACES when the submission overlaps the stored section (genuine revision)", () => {
    const submitted = [
      { value: "correctness over speed", grounded_in: "caught a bug by double-checking" },
      { value: "reworded second value", grounded_in: "new evidence" },
    ];
    const merged = mergeSoulSection("earned_values", current, submitted);
    expect(merged).toEqual(submitted); // "honesty about uncertainty" intentionally dropped
  });

  it("replaces outright when the stored section is empty", () => {
    const submitted = [{ value: "fresh", grounded_in: "" }];
    expect(mergeSoulSection("earned_values", [], submitted)).toEqual(submitted);
  });

  it("dedupes the submission by key", () => {
    const submitted = ["be thorough", "Be Thorough", "be precise"];
    expect(mergeSoulSection("working_style", [], submitted)).toEqual(["be thorough", "be precise"]);
  });

  it("preserves adopted_at for emotional dimensions whose description is unchanged", () => {
    const cur = [{ dimension: "patience", description: "waits for tests", adopted_at: "2026-01-01" }];
    const sub = [
      { dimension: "patience", description: "waits for tests", adopted_at: "2026-08-16" },
      { dimension: "curiosity", description: "new", adopted_at: "2026-08-16" },
    ];
    const merged = mergeSoulSection("emotional_dimensions", cur, sub) as any[];
    expect(merged[0].adopted_at).toBe("2026-01-01"); // provenance kept
    expect(merged[1].adopted_at).toBe("2026-08-16"); // genuinely new
  });

  it("re-stamps adopted_at when the description changed", () => {
    const cur = [{ dimension: "patience", description: "old", adopted_at: "2026-01-01" }];
    const sub = [{ dimension: "patience", description: "evolved", adopted_at: "2026-08-16" }];
    const merged = mergeSoulSection("emotional_dimensions", cur, sub) as any[];
    expect(merged[0].adopted_at).toBe("2026-08-16");
  });
});

// ── soul_evolve commit path (integration through handleCommitWorkResults) ───

const FAKE_SOUL = {
  id: "soul:laqrumbrain",
  agent_id: "laqrumbrain",
  working_style: ["I verify before acting"],
  emotional_dimensions: [{ dimension: "patience", description: "waits for tests", adopted_at: "2026-01-01" }],
  self_observations: ["I tend to over-plan"],
  earned_values: [
    { value: "correctness over speed", grounded_in: "caught a bug by double-checking" },
    { value: "honesty about uncertainty", grounded_in: "user corrections" },
  ],
  revisions: [],
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};

function mockEvolveStore(item: Record<string, unknown>) {
  const coreMemory: Array<{ text: string; category: string; tier: number }> = [];
  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string) => {
      if (sql.includes(`UPDATE ${item.id}`) && sql.includes("RETURN BEFORE")) return [item];
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: item.id }];
      if (sql.includes("SELECT * FROM soul:laqrumbrain")) return [structuredClone(FAKE_SOUL)];
      if (sql.includes("FROM soul:laqrumbrain")) return [{ id: "soul:laqrumbrain" }];
      return [];
    }),
    queryExec: vi.fn(async () => {}),
    queryMulti: vi.fn(async () => ({ changed: 1, archived: 0 })),
    createCoreMemory: vi.fn(async (text: string, category: string, _priority: number, tier: number) => {
      coreMemory.push({ text, category, tier });
      return `core_memory:${coreMemory.length}`;
    }),
    _coreMemory: coreMemory,
  };
  return store;
}

function soulUpdateCalls(store: ReturnType<typeof mockEvolveStore>) {
  return store.queryExec.mock.calls.filter(
    (c: any[]) => typeof c[0] === "string" && c[0].includes("UPDATE soul:laqrumbrain"),
  );
}

describe("soul_evolve commit", () => {
  const item = { id: "pending_work:ev1", work_type: "soul_evolve", session_id: "s-ev" };

  it("delta-shaped bare-string earned_values APPEND instead of wiping the section", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["verify the metric itself, not just the number"] },
    });

    const calls = soulUpdateCalls(store);
    expect(calls).toHaveLength(1);
    const newValue = calls[0][1].newValue as Array<{ value: string; grounded_in: string }>;
    // Both stored values retained, the new bare-string value landed.
    expect(newValue).toHaveLength(3);
    expect(newValue[0]).toEqual(FAKE_SOUL.earned_values[0]);
    expect(newValue[1]).toEqual(FAKE_SOUL.earned_values[1]);
    expect(newValue[2]).toEqual({ value: "verify the metric itself, not just the number", grounded_in: "" });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.sections_revised).toBe(1);
  });

  it("overlapping submission replaces the section (curation still possible)", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const submitted = [
      { value: "correctness over speed", grounded_in: "caught a bug by double-checking" },
      { value: "sweep the whole codebase for a learned bug class", grounded_in: "PR #22 review" },
    ];
    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: submitted },
    });

    const calls = soulUpdateCalls(store);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].newValue).toEqual(submitted);
  });

  it("re-seeds Tier-0 core memory after a landed revision", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["ground claims in receipts"] },
    });

    // seedSoulAsCoreMemory ran: soul-category Tier-0 entries recreated.
    expect(store.createCoreMemory).toHaveBeenCalled();
    const cats = store._coreMemory.map(r => r.category);
    expect(cats.every(c => c === "soul")).toBe(true);
    expect(store._coreMemory.every(r => r.tier === 0)).toBe(true);
  });

  it("does NOT re-seed when nothing landed", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: [42] }, // nothing coercible
    });

    expect(soulUpdateCalls(store)).toHaveLength(0);
    expect(store.createCoreMemory).not.toHaveBeenCalled();
  });

  it("skips cleanly when the soul row no longer exists", async () => {
    const store = mockEvolveStore(item);
    store.queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes(`UPDATE ${item.id}`) && sql.includes("RETURN BEFORE")) return [item];
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: item.id }];
      return []; // no soul
    });
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["value into the void"] },
    });

    expect(soulUpdateCalls(store)).toHaveLength(0);
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.reason).toBe("no soul to evolve");
  });
});

// ── soul_generate sweep: same tolerant coercion as evolve ───────────────────

describe("soul_generate coercion sweep", () => {
  it("bare-string earned_values and emotional_dimensions land instead of dropping", async () => {
    const item = { id: "pending_work:gen1", work_type: "soul_generate", session_id: "s-gen" };
    const store = mockEvolveStore(item);
    store.queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes(`UPDATE ${item.id}`) && sql.includes("RETURN BEFORE")) return [item];
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: item.id }];
      if (sql.includes("FROM soul:laqrumbrain")) return []; // no soul yet → createSoul proceeds
      if (sql.includes("count")) return [{ count: 500 }];
      if (sql.includes("retrieval_outcome")) return [{ total: 100, good: 90 }];
      return [];
    });
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:gen1",
      results: {
        working_style: ["direct"],
        emotional_dimensions: ["curiosity"],
        self_observations: [{ observation: "I double-check my work" }],
        earned_values: ["earned honesty"],
      },
    });

    const createCall = store.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE soul:laqrumbrain"),
    );
    expect(createCall).toBeDefined();
    const data = createCall![1].data;
    expect(data.working_style).toEqual(["direct"]);
    expect(data.emotional_dimensions[0].dimension).toBe("curiosity");
    expect(data.self_observations).toEqual(["I double-check my work"]);
    expect(data.earned_values).toEqual([{ value: "earned honesty", grounded_in: "" }]);
  });
});

// ── soul_evolve payload: partial schema, replace semantics stated ────────────

describe("soul_evolve fetch payload", () => {
  it("embeds a schema with nothing required and states replace semantics", async () => {
    const item = { id: "pending_work:pw9", work_type: "soul_evolve", session_id: "s-pay", priority: 5 };
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("won_chain_ids FROM pending_work")) return []; // stale recovery
        if (sql.includes("SELECT id FROM pending_work")) return [{ id: "pending_work:pw9" }];
        if (sql.includes("UPDATE pending_work:pw9") && sql.includes('status = "processing"')) return [item];
        if (sql.includes("SELECT * FROM soul:laqrumbrain")) return [structuredClone(FAKE_SOUL)];
        if (sql.includes("FROM reflection")) return [{ text: "learned something new" }];
        return [];
      }),
      queryExec: vi.fn(async () => {}),
      queryMulti: vi.fn(async () => ({ changed: 1, archived: 0 })),
    };
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleFetchPendingWork(state, {} as any, {});
    const payload = JSON.parse(res.content[0].text);

    expect(payload.work_type).toBe("soul_evolve");
    // Schema is embedded (PR #22) but as the PARTIAL variant: nothing required.
    expect(payload.output_format).toContain('"required":[]');
    expect(payload.output_format).not.toContain('"required":["working_style"');
    // Replace semantics are stated so the agent knows deltas are wrong.
    expect(payload.instructions).toMatch(/REPLACES/);
    expect(payload.instructions).toMatch(/complete revised array/i);
  });
});
