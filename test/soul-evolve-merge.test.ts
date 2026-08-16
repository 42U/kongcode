/**
 * Tests for the PR #22 follow-up hardening of the soul pipeline.
 *
 * Wave 1 (commit bc2dbcf): partial schema in the evolve payload, delta-guard
 * merge, tolerant per-section coercion, junk guard, post-revision Tier-0
 * re-seed.
 *
 * Wave 2 (this commit): the remaining review findings —
 *   #1 stale soul_generate zombies self-complete once a soul exists (fetch
 *      gate + actionable-count gate + graceful "exists" commit outcome),
 *   #2 bounded growth (per-section caps in evolve; revisions trim),
 *   #3 value-CAS guarded single-shot evolve write with re-merge retry
 *      (closes the read-modify-write lost-update race),
 *   #5 double-graduation race (tri-state createSoul; author-only side
 *      effects), junk-blanked evidence fields, payload input text caps.
 */

import { describe, it, expect, vi } from "vitest";
import * as pendingWork from "../src/tools/pending-work.js";
import { reviseSoulGuarded, SOUL_REVISIONS_CAP } from "../src/engine/soul.js";

const t = (pendingWork as any).__test__;
const coerceStringSection = t.coerceStringSection as (raw: unknown) => string[];
const coerceEmotionalDimensions = t.coerceEmotionalDimensions as (raw: unknown, now: string) => { dimension: string; description: string; adopted_at: string }[];
const coerceEarnedValues = t.coerceEarnedValues as (raw: unknown) => { value: string; grounded_in: string }[];
const mergeSoulSection = t.mergeSoulSection as (section: string, current: unknown[], submitted: unknown[]) => { mode: "append" | "replace"; merged: unknown[] };
const applySoulSectionCap = t.applySoulSectionCap as (section: string, mode: "append" | "replace", merged: unknown[]) => unknown[];

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

  it("blanks junky grounded_in instead of sinking the entry", () => {
    expect(coerceEarnedValues([{ value: "rigor", grounded_in: "no transcript data available" }]))
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

  it("blanks a junky description instead of dropping the dimension", () => {
    expect(coerceEmotionalDimensions([{ dimension: "patience", description: "nothing to extract here" }], NOW))
      .toEqual([{ dimension: "patience", description: "", adopted_at: NOW }]);
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
    const { mode, merged } = mergeSoulSection("earned_values", current, submitted);
    expect(mode).toBe("append");
    expect(merged).toHaveLength(3);
    expect(merged.slice(0, 2)).toEqual(current);
    expect(merged[2]).toEqual(submitted[0]);
  });

  it("REPLACES when the submission overlaps the stored section (genuine revision)", () => {
    const submitted = [
      { value: "correctness over speed", grounded_in: "caught a bug by double-checking" },
      { value: "reworded second value", grounded_in: "new evidence" },
    ];
    const { mode, merged } = mergeSoulSection("earned_values", current, submitted);
    expect(mode).toBe("replace");
    expect(merged).toEqual(submitted); // "honesty about uncertainty" intentionally dropped
  });

  it("replaces outright when the stored section is empty", () => {
    const submitted = [{ value: "fresh", grounded_in: "" }];
    const { mode, merged } = mergeSoulSection("earned_values", [], submitted);
    expect(mode).toBe("replace");
    expect(merged).toEqual(submitted);
  });

  it("dedupes the submission by key", () => {
    const { merged } = mergeSoulSection("working_style", [], ["be thorough", "Be Thorough", "be precise"]);
    expect(merged).toEqual(["be thorough", "be precise"]);
  });

  it("preserves adopted_at for emotional dimensions whose description is unchanged", () => {
    const cur = [{ dimension: "patience", description: "waits for tests", adopted_at: "2026-01-01" }];
    const sub = [
      { dimension: "patience", description: "waits for tests", adopted_at: "2026-08-16" },
      { dimension: "curiosity", description: "new", adopted_at: "2026-08-16" },
    ];
    const { merged } = mergeSoulSection("emotional_dimensions", cur, sub) as { merged: any[] };
    expect(merged[0].adopted_at).toBe("2026-01-01"); // provenance kept
    expect(merged[1].adopted_at).toBe("2026-08-16"); // genuinely new
  });

  it("re-stamps adopted_at when the description changed", () => {
    const cur = [{ dimension: "patience", description: "old", adopted_at: "2026-01-01" }];
    const sub = [{ dimension: "patience", description: "evolved", adopted_at: "2026-08-16" }];
    const { merged } = mergeSoulSection("emotional_dimensions", cur, sub) as { merged: any[] };
    expect(merged[0].adopted_at).toBe("2026-08-16");
  });
});

// ── Section caps (#2) ────────────────────────────────────────────────────────

describe("applySoulSectionCap", () => {
  it("append mode keeps the LAST N — oldest entries age out, new experience lands", () => {
    const merged = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, grounded_in: "" }));
    const capped = applySoulSectionCap("earned_values", "append", merged) as any[];
    expect(capped).toHaveLength(10);
    expect(capped[0].value).toBe("v2");
    expect(capped[9].value).toBe("v11");
  });

  it("replace mode keeps the FIRST N — the agent's own ordering (generate convention)", () => {
    const merged = Array.from({ length: 25 }, (_, i) => `style ${i}`);
    const capped = applySoulSectionCap("working_style", "replace", merged) as string[];
    expect(capped).toHaveLength(20);
    expect(capped[0]).toBe("style 0");
    expect(capped[19]).toBe("style 19");
  });

  it("no-ops under the cap", () => {
    const merged = ["a", "b"];
    expect(applySoulSectionCap("working_style", "append", merged)).toBe(merged);
  });
});

// ── reviseSoulGuarded (value-CAS primitive, #3) ─────────────────────────────

describe("reviseSoulGuarded", () => {
  function guardedStore(updateResults: Array<unknown[]>) {
    let call = 0;
    return {
      isAvailable: () => true,
      queryFirst: vi.fn(async (_sql: string) => updateResults[Math.min(call++, updateResults.length - 1)]),
      queryExec: vi.fn(async () => {}),
    };
  }

  it("returns 'applied' when the guarded UPDATE matches", async () => {
    const store = guardedStore([[{ id: "soul:laqrumbrain" }]]);
    const res = await reviseSoulGuarded(
      [{ section: "earned_values", value: [{ value: "x", grounded_in: "" }], snapshot: [] }],
      "test", store as any,
    );
    expect(res).toBe("applied");
    const sql = store.queryFirst.mock.calls[0][0] as string;
    expect(sql).toContain("earned_values = $w0");
    expect(sql).toContain("WHERE earned_values = $g0");
    expect(sql).toContain("revisions += $revs");
  });

  it("returns 'conflict' when the guard matches nothing (concurrent writer or missing soul)", async () => {
    const store = guardedStore([[]]);
    const res = await reviseSoulGuarded(
      [{ section: "earned_values", value: [{ value: "x", grounded_in: "" }], snapshot: [{ value: "stale", grounded_in: "" }] }],
      "test", store as any,
    );
    expect(res).toBe("conflict");
  });

  it("returns 'error' when the store throws", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async () => { throw new Error("boom"); }),
      queryExec: vi.fn(async () => {}),
    };
    const res = await reviseSoulGuarded(
      [{ section: "working_style", value: ["x"], snapshot: [] }],
      "test", store as any,
    );
    expect(res).toBe("error");
  });

  it("rejects non-whitelisted sections", async () => {
    const store = guardedStore([[{ id: "soul:laqrumbrain" }]]);
    const res = await reviseSoulGuarded(
      [{ section: "revisions" as any, value: [], snapshot: [] }],
      "test", store as any,
    );
    expect(res).toBe("applied"); // filtered to nothing → no-op success
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  it("trims revisions past SOUL_REVISIONS_CAP with a length-guarded UPDATE", async () => {
    const store = guardedStore([[{ id: "soul:laqrumbrain" }]]);
    const snapshotRevisions = Array.from({ length: SOUL_REVISIONS_CAP }, (_, i) => ({ section: "x", n: i }));
    await reviseSoulGuarded(
      [{ section: "working_style", value: ["a"], snapshot: [] }],
      "test", store as any,
      { snapshotRevisions },
    );
    const trimCall = store.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("SET revisions = $trimmed"),
    );
    expect(trimCall).toBeDefined();
    expect((trimCall![0] as string)).toContain("array::len(revisions) = $len");
    expect(trimCall![1].len).toBe(SOUL_REVISIONS_CAP + 1);
    expect(trimCall![1].trimmed).toHaveLength(SOUL_REVISIONS_CAP);
  });

  it("does not trim at or under the cap", async () => {
    const store = guardedStore([[{ id: "soul:laqrumbrain" }]]);
    await reviseSoulGuarded(
      [{ section: "working_style", value: ["a"], snapshot: [] }],
      "test", store as any,
      { snapshotRevisions: Array.from({ length: SOUL_REVISIONS_CAP - 1 }, () => ({})) },
    );
    expect(store.queryExec).not.toHaveBeenCalled();
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

/** Mock store for the evolve commit flow. `soulUpdateResults` scripts the
 *  guarded soul UPDATE's per-call result ([] = CAS conflict). */
function mockEvolveStore(item: Record<string, unknown>, opts: { soulUpdateResults?: Array<unknown[]>; hasSoul?: boolean } = {}) {
  const soulUpdateResults = opts.soulUpdateResults ?? [[{ id: "soul:laqrumbrain" }]];
  const hasSoulFlag = opts.hasSoul ?? true;
  let soulUpdateCallCount = 0;
  const coreMemory: Array<{ text: string; category: string; tier: number }> = [];
  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string) => {
      if (sql.includes(`UPDATE ${item.id}`) && sql.includes("RETURN BEFORE")) return [item];
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: item.id }];
      if (sql.includes("UPDATE soul:laqrumbrain")) {
        const res = soulUpdateResults[Math.min(soulUpdateCallCount++, soulUpdateResults.length - 1)];
        return res;
      }
      if (sql.includes("SELECT * FROM soul:laqrumbrain")) return hasSoulFlag ? [structuredClone(FAKE_SOUL)] : [];
      if (sql.includes("FROM soul:laqrumbrain")) return hasSoulFlag ? [{ id: "soul:laqrumbrain" }] : [];
      if (sql.includes("FROM core_memory")) return []; // reseed enumeration
      return [];
    }),
    queryExec: vi.fn(async () => {}),
    queryMulti: vi.fn(async () => ({ changed: 1, archived: 0 })),
    createCoreMemory: vi.fn(async (text: string, category: string, _priority: number, tier: number) => {
      coreMemory.push({ text, category, tier });
      return `core_memory:${coreMemory.length}`;
    }),
    _coreMemory: coreMemory,
    _soulUpdateCalls: () => store.queryFirst.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("UPDATE soul:laqrumbrain"),
    ),
  };
  return store;
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

    const calls = store._soulUpdateCalls();
    expect(calls).toHaveLength(1);
    const bindings = calls[0][1] as Record<string, any>;
    const newValue = bindings.w0 as Array<{ value: string; grounded_in: string }>;
    expect(newValue).toHaveLength(3);
    expect(newValue[0]).toEqual(FAKE_SOUL.earned_values[0]);
    expect(newValue[1]).toEqual(FAKE_SOUL.earned_values[1]);
    expect(newValue[2]).toEqual({ value: "verify the metric itself, not just the number", grounded_in: "" });
    // The write is guarded on the exact snapshot that was read.
    expect(bindings.g0).toEqual(FAKE_SOUL.earned_values);

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

    const calls = store._soulUpdateCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as any).w0).toEqual(submitted);
  });

  it("value-CAS conflict re-reads and re-merges, then lands (#3)", async () => {
    // First guarded UPDATE returns [] (concurrent writer), second applies.
    const store = mockEvolveStore(item, { soulUpdateResults: [[], [{ id: "soul:laqrumbrain" }]] });
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["a value earned under contention"] },
    });

    expect(store._soulUpdateCalls()).toHaveLength(2); // retried once
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.sections_revised).toBe(1);
  });

  it("gives up after exhausting CAS attempts without destroying anything", async () => {
    const store = mockEvolveStore(item, { soulUpdateResults: [[], [], []] });
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["never lands"] },
    });

    expect(store._soulUpdateCalls()).toHaveLength(3);
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true); // item completes; evolution retries on future experience
    expect(body.sections_revised).toBe(0);
    expect(store.createCoreMemory).not.toHaveBeenCalled(); // no re-seed
  });

  it("re-seeds Tier-0 core memory after a landed revision", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["ground claims in receipts"] },
    });

    expect(store.createCoreMemory).toHaveBeenCalled();
    expect(store._coreMemory.every(r => r.category === "soul" && r.tier === 0)).toBe(true);
  });

  it("does NOT re-seed when nothing landed", async () => {
    const store = mockEvolveStore(item);
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: [42] }, // nothing coercible
    });

    expect(store._soulUpdateCalls()).toHaveLength(0);
    expect(store.createCoreMemory).not.toHaveBeenCalled();
  });

  it("skips cleanly when the soul row no longer exists", async () => {
    const store = mockEvolveStore(item, { hasSoul: false });
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:ev1",
      results: { earned_values: ["value into the void"] },
    });

    expect(store._soulUpdateCalls()).toHaveLength(0);
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.reason).toBe("no soul to evolve");
  });
});

// ── soul_generate: sweep + zombie/race handling (#1, #5) ────────────────────

describe("soul_generate coercion sweep", () => {
  it("bare-string earned_values and emotional_dimensions land instead of dropping", async () => {
    const item = { id: "pending_work:gen1", work_type: "soul_generate", session_id: "s-gen" };
    const store = mockEvolveStore(item, { hasSoul: false });
    const store2 = store; // same mock: no soul → createSoul proceeds
    store2.queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes(`UPDATE ${item.id}`) && sql.includes("RETURN BEFORE")) return [item];
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: item.id }];
      if (sql.includes("FROM soul:laqrumbrain")) return []; // no soul before/after
      if (sql.includes("FROM core_memory")) return [];
      if (sql.includes("count")) return [{ count: 500 }];
      if (sql.includes("retrieval_outcome")) return [{ total: 100, good: 90 }];
      return [];
    });
    const state = { store: store2, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:gen1",
      results: {
        working_style: ["direct"],
        emotional_dimensions: ["curiosity"],
        self_observations: [{ observation: "I double-check my work" }],
        earned_values: ["earned honesty"],
      },
    });

    const createCall = store2.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE soul:laqrumbrain"),
    );
    expect(createCall).toBeDefined();
    const data = createCall![1].data;
    expect(data.working_style).toEqual(["direct"]);
    expect(data.emotional_dimensions[0].dimension).toBe("curiosity");
    expect(data.self_observations).toEqual(["I double-check my work"]);
    expect(data.earned_values).toEqual([{ value: "earned honesty", grounded_in: "" }]);
  });

  it("commit resolves 'soul already exists' gracefully with NO author side effects (#5 double-graduation)", async () => {
    const item = { id: "pending_work:gen2", work_type: "soul_generate", session_id: "s-gen2" };
    const store = mockEvolveStore(item, { hasSoul: true }); // soul exists → createSoul → "exists"
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:gen2",
      results: { working_style: ["anything"], emotional_dimensions: [], self_observations: [], earned_values: [] },
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.reason).toBe("soul already exists");
    // No graduation event, no core-memory seed — those are author-only.
    const gradCall = store.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("graduation_event"),
    );
    expect(gradCall).toBeUndefined();
    expect(store.createCoreMemory).not.toHaveBeenCalled();
  });
});

describe("soul_generate zombie self-completion (#1)", () => {
  it("fetch self-completes a generate item when a soul already exists", async () => {
    const item = { id: "pending_work:pwz", work_type: "soul_generate", session_id: "s-z", priority: 5 };
    let candidateCalls = 0;
    const terminalCalls: Array<Record<string, unknown>> = [];
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("won_chain_ids FROM pending_work")) return []; // stale recovery
        if (sql.includes("SELECT id FROM pending_work")) {
          // First pass: the zombie candidate; second pass (skip-ahead loop): drained.
          return candidateCalls++ === 0 ? [{ id: "pending_work:pwz" }] : [];
        }
        if (sql.includes("UPDATE pending_work:pwz") && sql.includes('status = "processing"')) return [item];
        if (sql.includes("FROM soul:laqrumbrain")) return [{ id: "soul:laqrumbrain" }]; // soul EXISTS
        return [];
      }),
      queryExec: vi.fn(async (sql: string, params?: Record<string, unknown>) => {
        if (sql.includes("pending_work:pwz") && params?.st) terminalCalls.push(params);
      }),
      queryMulti: vi.fn(async () => ({ changed: 1, archived: 0 })),
    };
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleFetchPendingWork(state, {} as any, {});
    const payload = JSON.parse(res.content[0].text);

    // The zombie was terminalized "completed" without any synthesis payload,
    // and the skip-ahead loop drained to the done message.
    expect(payload.empty).toBe(true);
    expect(terminalCalls.some(p => p.st === "completed" && p.wt === "soul_generate")).toBe(true);
  });
});

describe("countActionablePendingWork soul_generate gate (#1)", () => {
  it("counts 0 for pending generate rows once a soul exists", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("GROUP BY work_type")) return [{ work_type: "soul_generate", n: 3 }];
        if (sql.includes("FROM soul:laqrumbrain")) return [{ id: "soul:laqrumbrain" }]; // soul exists
        return [];
      }),
    };
    const n = await pendingWork.countActionablePendingWork(store as any);
    expect(n).toBe(0);
  });
});

// ── soul_evolve fetch payload: partial schema + input caps ──────────────────

describe("soul_evolve fetch payload", () => {
  function payloadStore(reflectionText: string) {
    const item = { id: "pending_work:pw9", work_type: "soul_evolve", session_id: "s-pay", priority: 5 };
    return {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("won_chain_ids FROM pending_work")) return [];
        if (sql.includes("SELECT id FROM pending_work")) return [{ id: "pending_work:pw9" }];
        if (sql.includes("UPDATE pending_work:pw9") && sql.includes('status = "processing"')) return [item];
        if (sql.includes("SELECT * FROM soul:laqrumbrain")) return [structuredClone(FAKE_SOUL)];
        if (sql.includes("FROM reflection")) return [{ text: reflectionText }];
        return [];
      }),
      queryExec: vi.fn(async () => {}),
      queryMulti: vi.fn(async () => ({ changed: 1, archived: 0 })),
    };
  }

  it("embeds a schema with nothing required and states replace semantics", async () => {
    const store = payloadStore("learned something new");
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleFetchPendingWork(state, {} as any, {});
    const payload = JSON.parse(res.content[0].text);

    expect(payload.work_type).toBe("soul_evolve");
    expect(payload.output_format).toContain('"required":[]');
    expect(payload.output_format).not.toContain('"required":["working_style"');
    expect(payload.instructions).toMatch(/REPLACES/);
    expect(payload.instructions).toMatch(/complete revised array/i);
  });

  it("caps oversized input texts (#5 payload bloat)", async () => {
    const store = payloadStore("x".repeat(5000));
    const state = { store, embeddings: { isAvailable: () => false, embed: vi.fn() } } as any;

    const res = await pendingWork.handleFetchPendingWork(state, {} as any, {});
    const payload = JSON.parse(res.content[0].text);

    expect(payload.data.new_reflections[0]).toHaveLength(600);
  });
});
