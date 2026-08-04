/**
 * 0.8.7: unit tests for the process-wedge escalation (WedgeDetector +
 * SurrealStore wiring) in src/engine/surreal.ts.
 *
 * Production incident (2026-08-02 → 08-04): every query from the daemon blew
 * the 60s deadline, every ensureConnected() reconnect "succeeded" (fresh
 * Surreal object, connect + signin round-tripped), and the next query died
 * again — for two days — while an identical fresh PROCESS (same SDK, same
 * node, same server, same SQL) answered in under a second. The 0.7.118
 * connection-level self-heal kept replacing the one component that wasn't
 * broken and had no feedback that its medicine wasn't working. These tests
 * pin the escalation that closes the class: conclude the PROCESS is wedged
 * and hand off to the daemon's exit path (spawn guard respawns clean).
 */
import { describe, it, expect, vi } from "vitest";
import { WedgeDetector, WEDGE_DEFAULTS, SurrealStore } from "../src/engine/surreal.js";

/** Small thresholds + a manually-advanced clock so tests run in microseconds. */
function makeDetector(
  overrides: Partial<{ minTimeouts: number; minHeals: number; minStreakMs: number }> = {},
  clock = { t: 0 },
) {
  const cfg = { minTimeouts: 3, minHeals: 2, minStreakMs: 1_000, ...overrides };
  return { d: new WedgeDetector(cfg, () => clock.t), clock };
}

describe("WedgeDetector", () => {
  it("fires only when ALL THREE thresholds hold, and exactly once (latch)", () => {
    const { d, clock } = makeDetector();
    // timeouts below threshold — never fires, regardless of time.
    expect(d.recordDeadlineTimeout()).toBe(false);
    expect(d.recordDeadlineTimeout()).toBe(false);
    clock.t = 5_000;
    // heals below threshold — still no fire even with timeouts + time satisfied.
    expect(d.recordDeadlineTimeout()).toBe(false); // timeouts now 3 = min
    expect(d.recordHealCompleted()).toBe(false); // heals 1 < 2
    // all three now hold → fires on the crossing event...
    expect(d.recordHealCompleted()).toBe(true);
    expect(d.escalated).toBe(true);
    // ...and never again (latch).
    expect(d.recordDeadlineTimeout()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false);
  });

  it("any query success resets the streak completely, including its clock", () => {
    const { d, clock } = makeDetector();
    d.recordDeadlineTimeout();
    d.recordDeadlineTimeout();
    d.recordHealCompleted();
    d.recordHealCompleted();
    clock.t = 10_000; // time floor satisfied for the OLD streak
    d.recordQuerySuccess();
    // A fresh streak must re-earn every threshold — the old accumulation and
    // the old start time are both gone.
    expect(d.recordDeadlineTimeout()).toBe(false);
    expect(d.recordDeadlineTimeout()).toBe(false);
    expect(d.recordDeadlineTimeout()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false); // heals=2, timeouts=3, but floor restarted at t=10s
    clock.t = 10_999; // 999ms into the new streak < 1s floor
    expect(d.recordDeadlineTimeout()).toBe(false);
    clock.t = 11_000; // floor met
    expect(d.recordDeadlineTimeout()).toBe(true);
  });

  it("heals outside an active streak are not evidence", () => {
    const { d } = makeDetector({ minHeals: 1, minTimeouts: 1, minStreakMs: 0 });
    // No timeouts yet → a completed reconnect (e.g. a routine server restart)
    // counts for nothing and cannot fire.
    expect(d.recordHealCompleted()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false);
    expect(d.escalated).toBe(false);
  });

  it("the time floor blocks a single burst (the 17-stuck-RPCs shape)", () => {
    // The incident's reconnect storms: one wedge event dumps a burst of
    // concurrent timeouts + a few completed heals within seconds. Count
    // thresholds are crossed instantly; only the floor holds the trigger.
    const { d, clock } = makeDetector({ minTimeouts: 10, minHeals: 3, minStreakMs: 180_000 });
    for (let i = 0; i < 17; i++) expect(d.recordDeadlineTimeout()).toBe(false);
    clock.t = 50_000;
    expect(d.recordHealCompleted()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false);
    expect(d.recordHealCompleted()).toBe(false); // counts met, 50s < 3min
    clock.t = 180_000; // three minutes of zero successes — no transient looks like this
    expect(d.recordDeadlineTimeout()).toBe(true);
  });

  it("default thresholds are sane and the floor respects its env clamp", () => {
    expect(WEDGE_DEFAULTS.minTimeouts).toBeGreaterThanOrEqual(5);
    expect(WEDGE_DEFAULTS.minHeals).toBeGreaterThanOrEqual(2);
    // Clamped [30s, 1h]; default 180s when LAQRUMCODE_WEDGE_STREAK_MS unset.
    expect(WEDGE_DEFAULTS.minStreakMs).toBeGreaterThanOrEqual(30_000);
    expect(WEDGE_DEFAULTS.minStreakMs).toBeLessThanOrEqual(3_600_000);
  });

  it("stats() names the evidence used in the escalation log line", () => {
    const { d, clock } = makeDetector();
    d.recordDeadlineTimeout();
    d.recordHealCompleted();
    clock.t = 42_000;
    expect(d.stats()).toBe(
      "1 query-deadline timeouts and 1 futile reconnects over 42s with zero successful queries",
    );
  });
});

describe("SurrealStore wedge wiring", () => {
  const cfg = { url: "ws://127.0.0.1:1/rpc", ns: "t", db: "t", user: "u", pass: "p" };

  function makeStore() {
    // skipSupervisorRegister: don't hijack the module-level supervisor
    // singleton from a unit test.
    return new SurrealStore(cfg as never, { skipSupervisorRegister: true });
  }

  it("a deadline timeout feeds the detector and a success resets it", async () => {
    const store = makeStore();
    const wedge = (store as any).wedge as WedgeDetector;
    (store as any).db = { query: () => new Promise(() => { /* zombie: never settles */ }) };
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 15)).rejects.toThrow(
      "deadline exceeded",
    );
    expect((store as any).zombieSuspect).toBe(true);
    expect(wedge.stats()).toContain("1 query-deadline timeouts");
    // A success ends the streak.
    (store as any).db = { query: async () => [["ok"]] };
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 15)).resolves.toEqual([["ok"]]);
    expect(wedge.stats()).toContain("0 query-deadline timeouts");
  });

  it("crossing the threshold fires the wired handler exactly once, with the evidence", async () => {
    const store = makeStore();
    const clock = { t: 0 };
    (store as any).wedge = new WedgeDetector(
      { minTimeouts: 2, minHeals: 0, minStreakMs: 0 },
      () => clock.t,
    );
    (store as any).db = { query: () => new Promise(() => {}) };
    const handler = vi.fn();
    store.setIrrecoverableWedgeHandler(handler);
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toContain("futile reconnects");
    expect(handler.mock.calls[0][0]).toContain("process replacement");
    // Latched: further timeouts don't re-fire.
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not fire during shutdown (the exit path itself blows deadlines)", async () => {
    const store = makeStore();
    (store as any).wedge = new WedgeDetector({ minTimeouts: 1, minHeals: 0, minStreakMs: 0 });
    (store as any).db = { query: () => new Promise(() => {}) };
    const handler = vi.fn();
    store.setIrrecoverableWedgeHandler(handler);
    store.markShutdown();
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("LAQRUMCODE_WEDGE_EXIT_DISABLED=1 suppresses the handler (log-only escape hatch)", async () => {
    const store = makeStore();
    (store as any).wedge = new WedgeDetector({ minTimeouts: 1, minHeals: 0, minStreakMs: 0 });
    (store as any).db = { query: () => new Promise(() => {}) };
    const handler = vi.fn();
    store.setIrrecoverableWedgeHandler(handler);
    process.env.LAQRUMCODE_WEDGE_EXIT_DISABLED = "1";
    try {
      await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      delete process.env.LAQRUMCODE_WEDGE_EXIT_DISABLED;
    }
  });

  it("an unwired store must not throw on escalation (library stays polite)", async () => {
    const store = makeStore();
    (store as any).wedge = new WedgeDetector({ minTimeouts: 1, minHeals: 0, minStreakMs: 0 });
    (store as any).db = { query: () => new Promise(() => {}) };
    // No setIrrecoverableWedgeHandler call — the mcp-server.ts / test embedder shape.
    await expect((store as any).deadlineQuery("RETURN 1", undefined, 10)).rejects.toThrow(
      "deadline exceeded", // the query error, not an escalation crash
    );
  });
});
