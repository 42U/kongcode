/**
 * Tests for commitKnowledge — the single write path.
 *
 * These tests verify the orchestration contract: the helper calls
 * upsertConcept, the linking helpers fire when enabled, and callers can
 * opt out of specific auto-seal steps. Integration behavior of the
 * linkers is covered in concept-extract.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { commitKnowledge } from "../src/engine/commit.js";
import type { GlobalPluginState } from "../src/engine/state.js";

function mockState(): GlobalPluginState {
  const store = {
    isAvailable: () => true,
    upsertConcept: vi.fn(async () => "concept:c1"),
    createMemory: vi.fn(async () => "memory:m1"),
    relate: vi.fn(async () => {}),
    queryFirst: vi.fn(async () => []),
  };
  const embeddings = {
    isAvailable: () => true,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  };
  return { store, embeddings } as unknown as GlobalPluginState;
}

describe("commitKnowledge — concept kind", () => {
  it("upserts the concept and returns an id", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "concept",
      name: "rate limiting",
      source: "test",
    });
    expect(result.id).toBe("concept:c1");
    expect(state.store.upsertConcept).toHaveBeenCalledWith(
      "rate limiting",
      expect.any(Array),
      "test",
      undefined,
    );
  });

  it("wires source → concept edge when sourceId and edgeName given", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "concept",
      name: "concept X",
      sourceId: "turn:t1",
      edgeName: "mentions",
      source: "test",
    });
    expect(state.store.relate).toHaveBeenCalledWith("turn:t1", "mentions", "concept:c1");
    expect(result.edges).toBeGreaterThan(0);
  });

  it("skips linkHierarchy when linkHierarchy: false", async () => {
    const state = mockState();
    // linkConceptHierarchy calls queryFirst — if we pass linkHierarchy: false,
    // we should see fewer queryFirst calls than the default path.
    const defaultResult = await commitKnowledge(state, {
      kind: "concept", name: "A", source: "test",
    });
    const defaultQueryCalls = state.store.queryFirst.mock.calls.length;

    const state2 = mockState();
    await commitKnowledge(state2, {
      kind: "concept", name: "B", source: "test",
      linkHierarchy: false, linkRelated: false,
    });
    const disabledQueryCalls = state2.store.queryFirst.mock.calls.length;

    expect(disabledQueryCalls).toBeLessThan(defaultQueryCalls);
  });

  it("uses precomputed embedding vector when provided (no embed call)", async () => {
    const state = mockState();
    const vec = new Array(1024).fill(0.2);
    await commitKnowledge(state, {
      kind: "concept",
      name: "with-vec",
      source: "test",
      precomputedVec: vec,
    });
    expect(state.embeddings.embed).not.toHaveBeenCalled();
    expect(state.store.upsertConcept).toHaveBeenCalledWith("with-vec", vec, "test", undefined);
  });

  it("still commits the concept row even when linking fails", async () => {
    const state = mockState();
    // Make queryFirst throw to simulate linker failure
    state.store.queryFirst = vi.fn(async () => { throw new Error("boom"); });
    const result = await commitKnowledge(state, {
      kind: "concept", name: "robust", source: "test",
    });
    // Core insert succeeded
    expect(result.id).toBe("concept:c1");
    expect(state.store.upsertConcept).toHaveBeenCalled();
  });
});

describe("commitKnowledge — memory kind", () => {
  it("inserts the memory and returns an id", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "memory",
      text: "user prefers verbose logging",
      importance: 7,
      category: "preference",
      sessionId: "session:s1",
    });
    expect(result.id).toBe("memory:m1");
    expect(state.store.createMemory).toHaveBeenCalledWith(
      "user prefers verbose logging",
      expect.any(Array),
      7,
      "preference",
      "session:s1",
    );
  });

  it("fires about_concept linking by default (non-zero edges)", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "memory",
      text: "user fixed the auth bug by upgrading jwt lib",
      importance: 6,
      category: "decision",
      sessionId: "session:s1",
    });
    expect(result.edges).toBeGreaterThan(0);
    // linkToRelevantConcepts does a vector-search queryFirst call
    expect(state.store.queryFirst).toHaveBeenCalled();
  });

  it("skips about_concept linking when linkConcepts: false", async () => {
    const state = mockState();
    await commitKnowledge(state, {
      kind: "memory",
      text: "T",
      importance: 5,
      category: "noise",
      linkConcepts: false,
    });
    // No queryFirst means no about_concept linker fired
    expect(state.store.queryFirst).not.toHaveBeenCalled();
  });

  it("uses precomputed vector when provided", async () => {
    const state = mockState();
    const vec = new Array(1024).fill(0.3);
    await commitKnowledge(state, {
      kind: "memory",
      text: "precomputed case",
      importance: 5,
      category: "test",
      precomputedVec: vec,
    });
    expect(state.embeddings.embed).not.toHaveBeenCalled();
    expect(state.store.createMemory).toHaveBeenCalledWith(
      "precomputed case", vec, 5, "test", undefined,
    );
  });
});
