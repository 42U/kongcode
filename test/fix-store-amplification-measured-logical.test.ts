/**
 * PR #18: store_amplification measures logical size instead of guessing 4KB/row.
 *
 * The old estimate (`embedded * 4096 * 1.3`) ignored retrieval_outcome and
 * embedding_cache and under-estimated embedding-heavy rows ~17x, so a healthy
 * 2.5GB store was flagged "25x bloat" forever (2026-07-10 false alarm; a full
 * export measured 1.71GB → true amplification ~1.3x). The fix samples 8 real
 * rows per heavy table, averages their JSON-serialized size, and multiplies by
 * the table's row count.
 *
 * Unit test with a routed mock store — the live-DB idiom can't reproduce the
 * false-positive case without ~500MB of real rows. Physical size is simulated
 * with a SPARSE file: dirSize() uses statSync().size (apparent size), so a
 * 5GB store costs zero disk.
 *
 * Case A fails on the pre-#18 code (false 31x warn); Case B proves the 200x
 * pathological case from the 2026-06-12 forensics is still caught.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMemoryHealth } from "../src/tools/memory-health.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const SPARSE_PHYSICAL = 5_000_000_000; // 5GB apparent size, zero disk cost

let tmp: string;
let savedStorePathEnv: string | undefined;

beforeAll(() => {
  savedStorePathEnv = process.env.LAQRUMCODE_STORE_PATH;
  delete process.env.LAQRUMCODE_STORE_PATH; // storePath must resolve via config.paths.dataDir
  tmp = mkdtempSync(join(tmpdir(), "kc-amp-test-"));
  const f = join(tmp, "store.vlog");
  writeFileSync(f, "");
  truncateSync(f, SPARSE_PHYSICAL);
});

afterAll(() => {
  if (savedStorePathEnv !== undefined) process.env.LAQRUMCODE_STORE_PATH = savedStorePathEnv;
  rmSync(tmp, { recursive: true, force: true });
});

/** Routed mock: count()/embedded-count SQL answered from maps, `SELECT * FROM
 *  <t> LIMIT 8` answered with sample rows, everything else (index-sanity, soul
 *  signals) benignly []. Mirrors the queryFirst<T>(): Promise<T[]> contract. */
function mockState(opts: {
  counts: Record<string, number>;
  embedded: Record<string, number>;
  sampleRow: Record<string, unknown>;
}): GlobalPluginState {
  const queryFirst = async (sql: string): Promise<unknown[]> => {
    const sample = /^SELECT \* FROM (\w+) LIMIT 8$/.exec(sql.trim());
    if (sample) {
      const n = opts.counts[sample[1]] ?? 0;
      return Array.from({ length: Math.min(8, n) }, (_, i) => ({
        id: `${sample[1]}:row${i}`,
        ...opts.sampleRow,
      }));
    }
    if (/^SELECT count\(\)/.test(sql.trim())) {
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? "";
      const n = sql.includes("embedding != NONE")
        ? (opts.embedded[table] ?? 0)
        : (opts.counts[table] ?? 0);
      return [{ n }];
    }
    return [];
  };
  return {
    store: {
      ping: async () => true,
      isAvailable: () => true,
      queryFirst,
    },
    config: { paths: { dataDir: tmp } },
    embeddings: undefined,
  } as unknown as GlobalPluginState;
}

async function ampDiagnostics(state: GlobalPluginState) {
  const res = await handleMemoryHealth(state, {} as SessionState, {});
  const report = JSON.parse(res.content[0].text) as {
    diagnostics: Array<{ severity: string; area: string; message: string }>;
  };
  return report.diagnostics.filter((d) => d.area === "store_amplification");
}

describe("store_amplification measured logical size (PR #18)", () => {
  it("does NOT false-alarm on an embedding-heavy store (old 4KB guess flagged 31x)", async () => {
    // 30k concept rows, ~20KB serialized each → measured ≈ 600MB.
    // 5GB physical / 600MB ≈ 8.3x < 10 → healthy, no warning.
    // Pre-#18: logical = 30_000 * 4096 * 1.3 ≈ 160MB → 31x → false warn.
    const state = mockState({
      counts: { concept: 30_000 },
      embedded: { concept: 30_000 },
      sampleRow: { content: "A".repeat(20_000) },
    });
    expect(await ampDiagnostics(state)).toEqual([]);
  });

  it("still catches the pathological dead-version bloat (2026-06-12 forensics class)", async () => {
    // Tiny live data → measured hits the 50MB floor → 5GB / 50MB = 100x → warn.
    const state = mockState({
      counts: { concept: 10, memory: 10, turn: 10 },
      embedded: { concept: 10, memory: 10, turn: 10 },
      sampleRow: { content: "x" },
    });
    const diags = await ampDiagnostics(state);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warn");
    expect(diags[0].message).toMatch(/100x/);
    expect(diags[0].message).toContain("compact-store.mjs");
  });
});
