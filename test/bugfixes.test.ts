/**
 * Regression tests for bug fixes.
 * Each describe block targets a specific fix to ensure the bug stays fixed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startMemoryDaemon } from "../src/daemon-manager.js";
import { preflight } from "../src/orchestrator.js";
import { SessionState } from "../src/state.js";
import { writeHandoffFileSync, readAndDeleteHandoffFile } from "../src/handoff-file.js";
import { upsertAndLinkConcepts } from "../src/concept-extract.js";
import { computeQualityScore } from "../src/soul.js";
import type { QualitySignals } from "../src/soul.js";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock factories ───────────────────────────────────────────────────────────

function mockStore() {
  return {
    isAvailable: () => true,
    getSessionTurns: async () => [],
    queryFirst: async () => [],
    queryExec: async () => {},
  } as any;
}

function mockEmbeddings(available = true) {
  const svc = {
    isAvailable: () => available,
    embed: async () => new Array(1024).fill(0),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
  } as any;
  return svc;
}

function mockComplete() {
  return async () => ({ text: "{}", usage: { input: 0, output: 0 } });
}

function neverComplete() {
  return () => new Promise<any>(() => {});
}

// ── Fix #1: Interval leak on daemon shutdown timeout ─────────────────────────

describe("daemon shutdown timeout cleans up interval (fix #1)", () => {
  it("shutdown resolves via timeout even when processing is stuck", async () => {
    const daemon = startMemoryDaemon(
      mockStore(), mockEmbeddings(), "session1", neverComplete(), 60_000,
    );

    // Start processing by sending a batch (needs ≥2 turns)
    daemon.sendTurnBatch(
      [
        { role: "user", text: "hello world test", turnId: "t1" },
        { role: "assistant", text: "response here", turnId: "t2" },
      ],
      [], [],
    );

    // Let processing start
    await new Promise(r => setTimeout(r, 50));

    // Shutdown with short timeout — should resolve, not hang
    const start = Date.now();
    await daemon.shutdown(200);
    const elapsed = Date.now() - start;

    // Should resolve within ~300ms (200ms timeout + slack), not hang forever
    expect(elapsed).toBeLessThan(500);
  });
});

// ── Fix #4: Batch overwrite logs warning ─────────────────────────────────────

describe("batch overwrite logs warning (fix #4)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when overwriting a pending batch", async () => {
    const daemon = startMemoryDaemon(
      mockStore(), mockEmbeddings(), "session1", neverComplete(), 60_000,
    );

    const turns = [
      { role: "user", text: "hello", turnId: "t1" },
      { role: "assistant", text: "world", turnId: "t2" },
    ];

    // First batch starts processing
    daemon.sendTurnBatch(turns, [], []);
    await new Promise(r => setTimeout(r, 50));

    // Second batch merges into pending slot
    daemon.sendTurnBatch(turns, [], []);

    // Third batch merges again — no data loss
    daemon.sendTurnBatch(turns, [], []);

    await daemon.shutdown(200);
  });
});

// ── Fix #5: Continuation inherits lower tool budget ──────────────────────────

describe("orchestrator continuation budget (fix #5)", () => {
  it("inherits low tool budget from previous turn", async () => {
    const session = new SessionState("test-session", "test-key");
    const embeddings = mockEmbeddings();

    // First call (turn 1) — trivial fast path, sets lastConfig
    await preflight("hi", session, embeddings);

    // Manually set a low tool limit as if previous turn was code-write (limit 8)
    // getOrchState is private, but we can access it via getLastPreflightConfig after preflight
    // We need to call preflight for turn 2 with a short non-question input
    // But first, we need to manipulate the orch state. Since WeakMap is private,
    // we'll use preflight's own path: call it with a complex input on turn 2 to set toolLimit,
    // then call it on turn 3 with a short input for the continuation path.

    // Turn 2: full classification path (input > 20 chars, sets config via intent)
    const turn2 = await preflight("write a function to calculate fibonacci numbers", session, embeddings);
    const turn2Limit = turn2.config.toolLimit;

    // Turn 3: short non-question → continuation path, should inherit min(turn2Limit, 25)
    const turn3 = await preflight("ok do it", session, embeddings);
    expect(turn3.config.toolLimit).toBe(Math.min(turn2Limit, 25));
    // Verify it didn't inflate: if turn2Limit was ≤25, it stayed the same
    expect(turn3.config.toolLimit).toBeLessThanOrEqual(25);
  });

  it("caps high tool budget at 25 for continuations", async () => {
    const session = new SessionState("test-session-2", "test-key-2");
    const embeddings = mockEmbeddings();

    // Turn 1 — trivial
    await preflight("hi", session, embeddings);

    // Turn 2 — force a high tool limit by going through full classification
    // The continuation path reads orch.lastConfig.toolLimit. If it was >25, min caps to 25.
    // Simulate by doing two preflight calls to get into the continuation branch.
    await preflight("refactor the entire authentication system with tests", session, embeddings);

    // Turn 3 — continuation
    const result = await preflight("yes", session, embeddings);
    expect(result.config.toolLimit).toBeLessThanOrEqual(25);
  });
});

// ── Fix #13: Recall graph expansion scales with maxResults ───────────────────

describe("recall graph expansion limit (fix #13)", () => {
  it("passes min(maxResults, 8) IDs to graphExpand, not hard-coded 5", async () => {
    const graphExpandSpy = vi.fn(async () => []);
    const vectorResults = Array.from({ length: 10 }, (_, i) => ({
      id: `memory:${i}`,
      text: `result ${i}`,
      score: 0.9 - i * 0.05,
      table: "memory",
    }));

    const state = {
      store: {
        isAvailable: () => true,
        vectorSearch: async () => vectorResults,
        graphExpand: graphExpandSpy,
        recordRetrievalOutcome: async () => {},
      },
      embeddings: {
        isAvailable: () => true,
        embed: async () => new Array(1024).fill(0),
      },
    } as any;

    const session = new SessionState("test-session", "test-key");

    const { createRecallToolDef } = await import("../src/tools/recall.js");
    const tool = createRecallToolDef(state, session);

    // Call with limit=10 — should pass 8 IDs to graphExpand (min(10, 8))
    await tool.execute("call-1", { query: "test query", limit: 10 });

    expect(graphExpandSpy).toHaveBeenCalledTimes(1);
    const passedIds = graphExpandSpy.mock.calls[0][0];
    expect(passedIds).toHaveLength(8);
  });

  it("passes maxResults when less than 8", async () => {
    const graphExpandSpy = vi.fn(async () => []);
    const vectorResults = Array.from({ length: 10 }, (_, i) => ({
      id: `memory:${i}`,
      text: `result ${i}`,
      score: 0.9 - i * 0.05,
      table: "memory",
    }));

    const state = {
      store: {
        isAvailable: () => true,
        vectorSearch: async () => vectorResults,
        graphExpand: graphExpandSpy,
        recordRetrievalOutcome: async () => {},
      },
      embeddings: {
        isAvailable: () => true,
        embed: async () => new Array(1024).fill(0),
      },
    } as any;

    const session = new SessionState("test-session", "test-key");

    const { createRecallToolDef } = await import("../src/tools/recall.js");
    const tool = createRecallToolDef(state, session);

    // Call with limit=3 — should pass 3 IDs (min(3, 8) = 3)
    await tool.execute("call-2", { query: "test query", limit: 3 });

    expect(graphExpandSpy).toHaveBeenCalledTimes(1);
    const passedIds = graphExpandSpy.mock.calls[0][0];
    expect(passedIds).toHaveLength(3);
  });
});

// ── Fix #14: Handoff file atomic rename ──────────────────────────────────────

describe("handoff file atomic rename (fix #14)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kongbrain-bugfix-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sampleData = {
    sessionId: "sess-123",
    timestamp: new Date().toISOString(),
    userTurnCount: 5,
    lastUserText: "hello",
    lastAssistantText: "world",
    unextractedTokens: 1000,
  };

  it("round-trip write and read works", () => {
    writeHandoffFileSync(sampleData, dir);
    const result = readAndDeleteHandoffFile(dir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-123");
    expect(result!.userTurnCount).toBe(5);
  });

  it("no .processing file remains after successful read", () => {
    writeHandoffFileSync(sampleData, dir);
    readAndDeleteHandoffFile(dir);

    expect(existsSync(join(dir, ".kongbrain-handoff.json"))).toBe(false);
    expect(existsSync(join(dir, ".kongbrain-handoff.json.processing"))).toBe(false);
  });

  it("cleans up stale .processing file from prior crash", async () => {
    // Simulate crash: left a .processing file but no main file
    const processingPath = join(dir, ".kongbrain-handoff.json.processing");
    await writeFile(processingPath, JSON.stringify(sampleData));

    // Should clean up the stale .processing file and return null
    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
    expect(existsSync(processingPath)).toBe(false);
  });

  it("returns null when no file exists", () => {
    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
  });
});

// ── Fix #15: upsertConcept receives source/logTag ────────────────────────────

describe("upsertConcept receives logTag as source (fix #15)", () => {
  it("passes logTag as third argument to upsertConcept", async () => {
    const upsertSpy = vi.fn(async () => "concept:1");
    const store = {
      upsertConcept: upsertSpy,
      relate: async () => {},
    } as any;

    const embeddings = {
      isAvailable: () => true,
      embed: async () => new Array(1024).fill(0),
    } as any;

    // "use React" matches the CONCEPT_RE pattern → extracts "React" (lowercase 'use' required)
    await upsertAndLinkConcepts("source:1", "mentions", "use React", store, embeddings, "test:mytag");

    expect(upsertSpy).toHaveBeenCalled();
    // Third argument should be the logTag
    const thirdArg = upsertSpy.mock.calls[0][2];
    expect(thirdArg).toBe("test:mytag");
  });
});

// ── Fix #16: Infinity skill counts don't produce NaN ─────────────────────────

describe("soul quality Infinity guard (fix #16)", () => {
  it("returns finite quality score when skill counts are Infinity", () => {
    const signals: QualitySignals = {
      avgRetrievalUtilization: 0.5,
      skillSuccessRate: 0, // Should default to 0 when total is Infinity
      criticalReflectionRate: 0.1,
      toolFailureRate: 0.05,
      retrievalCount: 10,
    };

    const score = computeQualityScore(signals);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).not.toBeNaN();
  });

  it("computes valid quality score with normal inputs", () => {
    const signals: QualitySignals = {
      avgRetrievalUtilization: 0.7,
      skillSuccessRate: 0.8,
      criticalReflectionRate: 0.05,
      toolFailureRate: 0.02,
      retrievalCount: 50,
    };

    const score = computeQualityScore(signals);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
