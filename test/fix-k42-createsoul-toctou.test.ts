/**
 * K42 regression — createSoul() had a check-then-create TOCTOU on the fixed
 * `soul:laqrumbrain` id with no try/catch. If a concurrent caller (two
 * session-end pipelines, or a retry) slips between hasSoul() and the CREATE,
 * the second CREATE throws "already exists" and the whole call rejected.
 *
 * The fix wraps the CREATE in try/catch and treats already-exists as
 * idempotent presence (re-checking hasSoul() after the catch). These tests
 * use a mock store; the "throws then resolves" case FAILS against the
 * pre-fix code (the error propagated out of createSoul()).
 *
 * v0.8.8: createSoul returns a tri-state instead of a boolean. The old
 * boolean conflated "we authored the soul" with "we lost the race but it
 * exists" (both `true`), which let two concurrent soul_generate commits each
 * record a graduation_event — the double-celebration bug. "exists" now covers
 * both the up-front check and the race loss; only "created" means authorship.
 */
import { describe, it, expect, vi } from "vitest";
import { createSoul } from "../src/engine/soul.js";

const emptyDoc = {
  working_style: [],
  emotional_dimensions: [],
  self_observations: [],
  earned_values: [],
} as any;

describe("K42: createSoul TOCTOU idempotency", () => {
  it("resolves 'exists' (not throw) when CREATE loses the race but the soul exists", async () => {
    let soulExists = false; // hasSoul() before CREATE → false; after → true
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM soul:laqrumbrain")) return soulExists ? [{ id: "soul:laqrumbrain" }] : [];
        return [];
      }),
      queryExec: vi.fn(async () => {
        // Simulate the concurrent winner having created it just now.
        soulExists = true;
        throw new Error("Database record `soul:laqrumbrain` already exists");
      }),
    };
    // Must resolve (never reject) — and report presence, not authorship.
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe("exists");
  });

  it("resolves 'failed' when CREATE fails for a real reason and no soul exists", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM soul:laqrumbrain")) return []; // never exists
        return [];
      }),
      queryExec: vi.fn(async () => { throw new Error("disk full"); }),
    };
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe("failed");
  });

  it("resolves 'exists' up front when the soul already exists, without attempting CREATE", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async () => [{ id: "soul:laqrumbrain" }]),
      queryExec: vi.fn(async () => {}),
    };
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe("exists");
    expect(store.queryExec).not.toHaveBeenCalled();
  });

  it("resolves 'created' when the CREATE genuinely lands", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async () => []), // no soul before or after
      queryExec: vi.fn(async () => {}),
    };
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe("created");
    expect(store.queryExec).toHaveBeenCalledOnce();
  });
});
