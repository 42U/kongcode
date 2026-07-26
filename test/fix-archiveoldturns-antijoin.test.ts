/**
 * v0.8.5 — archiveOldTurns anti-join rewrite.
 *
 * The old query selected stale turns via an in-DB
 *   `<string>id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome
 *    WHERE memory_table='turn')`
 * with LIMIT applied AFTER the membership filter, so the WHOLE backlog (not just
 * the LIMIT) paid an O(stale × referenced) per-row string-cast membership test.
 * Once the backlog grew (~2026-06) it crossed the 8s TIMEOUT, threw, recorded no
 * maintenance_runs row, and re-fired every boot — a CPU sink and an accelerant
 * of the 2026-06-27 daemon flap.
 *
 * Rewrite: two INDEXED scans (candidate stale turns + referenced memory_ids) +
 * a pure O(stale + referenced) Set anti-join (selectUnreferencedTurns), covered
 * directly below, plus static-source guards that the O(n×m) pattern is gone and
 * the catch records a status='error' row (which engages the 30-min backoff).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { selectUnreferencedTurns } from "../src/engine/surreal.js";

const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const cand = (sid: string) => ({ id: sid, sid });

describe("selectUnreferencedTurns — archiveOldTurns anti-join (pure)", () => {
  it("keeps turns NOT referenced by any retrieval_outcome, drops referenced ones", () => {
    const out = selectUnreferencedTurns(
      [cand("turn:a"), cand("turn:b"), cand("turn:c")],
      ["turn:b"],
      500,
    );
    expect(out.map((r) => r.sid)).toEqual(["turn:a", "turn:c"]);
  });

  it("ignores non-turn memory_ids (e.g. 'guaranteed:...') — they can't equal a turn sid", () => {
    const out = selectUnreferencedTurns(
      [cand("turn:a"), cand("turn:b")],
      ["guaranteed:2026-06-24T20:36:34Z", "memory:x"],
      500,
    );
    expect(out.map((r) => r.sid)).toEqual(["turn:a", "turn:b"]);
  });

  it("respects the limit (drains in bounded batches)", () => {
    const out = selectUnreferencedTurns(
      [cand("turn:a"), cand("turn:b"), cand("turn:c"), cand("turn:d")],
      [],
      2,
    );
    expect(out.map((r) => r.sid)).toEqual(["turn:a", "turn:b"]);
  });

  it("coerces referenced values via String() so record-id-like objects still match", () => {
    const recordLike = { toString: () => "turn:a" };
    const out = selectUnreferencedTurns([cand("turn:a"), cand("turn:b")], [recordLike], 500);
    expect(out.map((r) => r.sid)).toEqual(["turn:b"]);
  });

  it("returns everything when nothing is referenced, and [] when all referenced", () => {
    expect(selectUnreferencedTurns([cand("turn:a"), cand("turn:b")], [], 500)).toHaveLength(2);
    expect(
      selectUnreferencedTurns([cand("turn:a"), cand("turn:b")], ["turn:a", "turn:b"], 500),
    ).toHaveLength(0);
  });

  it("handles an empty candidate set", () => {
    expect(selectUnreferencedTurns([], ["turn:a"], 500)).toEqual([]);
  });
});

describe("archiveOldTurns source — O(n×m) anti-join removed, error row recorded", () => {
  const start = surrealSrc.indexOf("async archiveOldTurns(");
  const nextMethod = surrealSrc.indexOf("\n  async ", start + 10);
  const body = surrealSrc.slice(start, nextMethod > -1 ? nextMethod : start + 3000);

  it("locates the method", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("no longer runs the in-DB O(n×m) anti-join query (NOT IN ... LIMIT 500)", () => {
    // the removed CODE had this contiguous, space-normalized form; the new
    // explanatory comment line-wraps it and drops the spaces, so this regex
    // matches the old code but not the comment that documents it.
    expect(body).not.toMatch(
      /NOT IN \(SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn'\) LIMIT 500/,
    );
  });

  it("uses the two-scan + Set helper (selectUnreferencedTurns)", () => {
    expect(body).toContain("selectUnreferencedTurns(");
    expect(body).toMatch(/SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn'/);
  });

  it("records a status='error' maintenance_runs row on failure (engages FAILURE_BACKOFF)", () => {
    expect(body).toMatch(/recordMaintenanceRun\(\s*"archiveOldTurns",\s*0,[\s\S]*?"error"/);
  });

  it("keeps the 8s server-side TIMEOUT safety cap on the scans", () => {
    expect((body.match(/TIMEOUT 8s/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
