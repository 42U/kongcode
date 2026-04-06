/**
 * Tests for supersedes.ts — concept evolution tracking.
 *
 * Verifies that when a correction is processed, stale concepts are found
 * via vector search, supersedes edges are created, and stability is decayed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkSupersedesEdges } from "../src/supersedes.js";

// ── Mock helpers ──

function mockStore(candidates: Array<{ id: string; score: number; stability: number }> = []) {
  return {
    queryFirst: vi.fn(async () => candidates),
    queryExec: vi.fn(async () => {}),
    relate: vi.fn(async () => {}),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  } as any;
}

// ── linkSupersedesEdges ──

describe("linkSupersedesEdges", () => {
  let store: ReturnType<typeof mockStore>;
  let embeddings: ReturnType<typeof mockEmbeddings>;

  beforeEach(() => {
    store = mockStore();
    embeddings = mockEmbeddings();
  });

  it("returns 0 and skips when embeddings unavailable", async () => {
    embeddings = mockEmbeddings(false);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(0);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  it("returns 0 when originalText is empty", async () => {
    const count = await linkSupersedesEdges(
      "memory:m1", "", "right thing", store, embeddings,
    );
    expect(count).toBe(0);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("returns 0 when embed returns null", async () => {
    embeddings.embed.mockResolvedValueOnce(null);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(0);
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  it("passes stability floor to query for pre-filtering", async () => {
    store = mockStore([]);
    await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(store.queryFirst).toHaveBeenCalledWith(
      expect.stringContaining("stability > $floor"),
      expect.objectContaining({ floor: 0.15 }),
    );
  });

  it("returns 0 when no candidates above threshold", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.5, stability: 0.8 },
      { id: "concept:c2", score: 0.3, stability: 0.9 },
    ]);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(0);
    expect(store.relate).not.toHaveBeenCalled();
    expect(store.queryExec).not.toHaveBeenCalled();
  });

  it("creates supersedes edge and decays stability for matching concept", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.85, stability: 0.9 },
    ]);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(1);

    // Should RELATE correction -> supersedes -> stale concept
    expect(store.relate).toHaveBeenCalledWith("memory:m1", "supersedes", "concept:c1");

    // Should decay stability: 0.9 * 0.4 ≈ 0.36
    expect(store.queryExec).toHaveBeenCalledTimes(1);
    const [sql, bindings] = store.queryExec.mock.calls[0];
    expect(sql).toContain("UPDATE");
    expect(bindings.conceptId).toBe("concept:c1");
    expect(bindings.correctionId).toBe("memory:m1");
    expect(bindings.newStability).toBeCloseTo(0.36, 10);
  });

  it("applies stability floor when decay would go below 0.15", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.90, stability: 0.2 },
    ]);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(1);

    // 0.2 * 0.4 = 0.08 → clamped to floor 0.15
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE"),
      expect.objectContaining({
        newStability: 0.15,
      }),
    );
  });

  it("handles multiple candidates, stops at threshold boundary", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.90, stability: 1.0 },
      { id: "concept:c2", score: 0.75, stability: 0.8 },
      { id: "concept:c3", score: 0.65, stability: 0.9 }, // below 0.70 — should stop
    ]);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(2);
    expect(store.relate).toHaveBeenCalledTimes(2);
    expect(store.queryExec).toHaveBeenCalledTimes(2);
  });

  it("embeds the original (wrong) text, not the correction", async () => {
    store = mockStore([]);
    await linkSupersedesEdges(
      "memory:m1", "the earth is flat", "the earth is round", store, embeddings,
    );
    expect(embeddings.embed).toHaveBeenCalledWith("the earth is flat");
  });

  it("defaults stability to 1.0 when concept has no stability field", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.80, stability: undefined as any },
    ]);
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(1);

    // undefined ?? 1.0 = 1.0; 1.0 * 0.4 = 0.4
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE"),
      expect.objectContaining({
        newStability: 0.4,
      }),
    );
  });

  it("swallows relate errors gracefully", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.85, stability: 0.9 },
    ]);
    store.relate.mockRejectedValueOnce(new Error("DB down"));

    // Should not throw
    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    // relate failed but queryExec still runs — count is 1
    expect(count).toBe(1);
  });

  it("swallows queryExec (decay) errors gracefully", async () => {
    store = mockStore([
      { id: "concept:c1", score: 0.85, stability: 0.9 },
    ]);
    store.queryExec.mockRejectedValueOnce(new Error("DB down"));

    const count = await linkSupersedesEdges(
      "memory:m1", "wrong thing", "right thing", store, embeddings,
    );
    expect(count).toBe(1);
  });
});
