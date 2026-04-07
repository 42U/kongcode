/**
 * Tests for wakeup.ts — session startup briefing assembly.
 *
 * synthesizeWakeup gathers prior state (handoff, identity, monologues, soul,
 * maturity, previous turns) and returns formatted sections as the briefing.
 */

import { describe, it, expect, vi } from "vitest";
import { synthesizeWakeup } from "../src/engine/wakeup.js";

// ── Mock helpers ──

function mockStore(overrides: Record<string, any> = {}) {
  return {
    isAvailable: () => true,
    queryFirst: vi.fn(async () => []),
    getLatestHandoff: vi.fn(async () => overrides.handoff ?? null),
    getAllIdentityChunks: vi.fn(async () => overrides.identity ?? []),
    getRecentMonologues: vi.fn(async () => overrides.monologues ?? []),
    getPreviousSessionTurns: vi.fn(async () => overrides.previousTurns ?? []),
    countResolvedSinceHandoff: vi.fn(async () => overrides.resolvedCount ?? 0),
    // For getDepthSignals (fires 4 parallel queries)
    ...({
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM session GROUP ALL")) return [{ count: overrides.sessions ?? 0 }];
        if (sql.includes("FROM monologue GROUP ALL")) return [{ count: overrides.monologueCount ?? 0 }];
        if (sql.includes("FROM memory GROUP ALL")) return [{ count: overrides.memoryCount ?? 0 }];
        if (sql.includes("FROM session ORDER BY")) return overrides.spanStart ? [{ earliest: overrides.spanStart }] : [];
        // hasSoul
        if (sql.includes("FROM soul")) return overrides.hasSoul ? [{ id: "soul:1" }] : [];
        // checkGraduation queries
        return [];
      }),
    }),
  } as any;
}

// ── Tests ──

describe("synthesizeWakeup", () => {
  it("returns null when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const result = await synthesizeWakeup(store);
    expect(result).toBeNull();
  });

  it("returns null on first boot (no prior state)", async () => {
    const store = mockStore();
    const result = await synthesizeWakeup(store);
    expect(result).toBeNull();
  });

  it("returns briefing with handoff section when handoff exists", async () => {
    const store = mockStore({
      handoff: { text: "Working on auth module. TODO: add rate limiting.", created_at: new Date().toISOString() },
      sessions: 5,
    });

    const result = await synthesizeWakeup(store);

    expect(result).toBeTruthy();
    expect(result).toContain("[LAST HANDOFF]");
    expect(result).toContain("Working on auth module");
  });

  it("includes depth signals in briefing", async () => {
    const store = mockStore({
      handoff: { text: "some work", created_at: new Date().toISOString() },
      sessions: 15,
      memoryCount: 42,
      monologueCount: 8,
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("[DEPTH]");
    expect(result).toContain("~15 sessions");
    expect(result).toContain("42 memories");
  });

  it("includes previous session turns in briefing", async () => {
    const store = mockStore({
      previousTurns: [
        { role: "user", text: "fix the login bug" },
        { role: "assistant", text: "I found the issue — null check missing in auth.ts" },
      ],
      handoff: { text: "working on auth", created_at: new Date().toISOString() },
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("[PREVIOUS SESSION — LAST MESSAGES]");
    expect(result).toContain("USER: fix the login bug");
    expect(result).toContain("ASSISTANT:");
  });

  it("includes identity chunks in briefing", async () => {
    const store = mockStore({
      identity: [
        { text: "You have persistent memory across sessions" },
        { text: "Your preferences matter" },
      ],
      handoff: { text: "continuing work", created_at: new Date().toISOString() },
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("[IDENTITY]");
    expect(result).toContain("persistent memory");
  });

  it("includes monologues in briefing", async () => {
    const store = mockStore({
      monologues: [
        { category: "insight", content: "The caching layer needs refactoring" },
        { category: "doubt", content: "Not sure about the DB schema" },
      ],
      handoff: { text: "working", created_at: new Date().toISOString() },
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("[RECENT THINKING]");
    expect(result).toContain("[insight] The caching layer");
  });

  it("annotates handoff age in hours", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const store = mockStore({
      handoff: { text: "old work", created_at: twoHoursAgo },
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("2h old");
  });

  it("notes resolved memories since handoff", async () => {
    const store = mockStore({
      handoff: { text: "had some issues", created_at: new Date().toISOString() },
      resolvedCount: 3,
    });

    const result = await synthesizeWakeup(store);

    expect(result).toContain("3 memories resolved since");
  });

  it("returns briefing when only monologues exist (no handoff or previous turns)", async () => {
    // Line 169: !handoff && monologues.length === 0 && previousTurns.length === 0 → null
    // monologues.length > 0, so it proceeds
    const store = mockStore({
      monologues: [{ category: "insight", content: "something" }],
    });

    const result = await synthesizeWakeup(store);
    expect(result).toBeTruthy();
    expect(result).toContain("[RECENT THINKING]");
  });

  it("returns null when no handoff, monologues, or previous turns", async () => {
    // Even with identity chunks, the guard at line 169 returns null
    const store = mockStore({
      identity: [{ text: "some identity" }],
    });

    const result = await synthesizeWakeup(store);
    expect(result).toBeNull();
  });
});
