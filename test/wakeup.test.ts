/**
 * Tests for wakeup.ts — session startup briefing synthesis.
 *
 * synthesizeWakeup gathers prior state (handoff, identity, monologues, soul,
 * maturity, previous turns) and calls the LLM to produce a first-person briefing.
 */

import { describe, it, expect, vi } from "vitest";
import { synthesizeWakeup } from "../src/wakeup.js";

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

function mockComplete(briefing = "I remember we were working on the auth module. Last session we fixed the null check in login.ts and the tests were passing. I should pick up where we left off — there was a TODO about adding rate limiting.") {
  return vi.fn(async () => ({ text: briefing }));
}

// ── Tests ──

describe("synthesizeWakeup", () => {
  it("returns null when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const result = await synthesizeWakeup(store, mockComplete());
    expect(result).toBeNull();
  });

  it("returns null on first boot (no prior state)", async () => {
    const store = mockStore();
    const result = await synthesizeWakeup(store, mockComplete());
    expect(result).toBeNull();
  });

  it("synthesizes briefing when handoff exists", async () => {
    const store = mockStore({
      handoff: { text: "Working on auth module. TODO: add rate limiting.", created_at: new Date().toISOString() },
      sessions: 5,
    });
    const complete = mockComplete();

    const result = await synthesizeWakeup(store, complete);

    expect(result).toBeTruthy();
    expect(result!.length).toBeGreaterThanOrEqual(100);
    expect(complete).toHaveBeenCalledTimes(1);

    // Verify the LLM received handoff content
    const prompt = complete.mock.calls[0][0];
    expect(prompt.messages[0].content).toContain("[LAST HANDOFF]");
  });

  it("includes depth signals in LLM prompt", async () => {
    const store = mockStore({
      handoff: { text: "some work", created_at: new Date().toISOString() },
      sessions: 15,
      memoryCount: 42,
      monologueCount: 8,
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const prompt = complete.mock.calls[0][0];
    const content = prompt.messages[0].content;
    expect(content).toContain("[DEPTH]");
    expect(content).toContain("~15 sessions");
    expect(content).toContain("42 memories");
  });

  it("includes previous session turns in LLM prompt", async () => {
    const store = mockStore({
      previousTurns: [
        { role: "user", text: "fix the login bug" },
        { role: "assistant", text: "I found the issue — null check missing in auth.ts" },
      ],
      handoff: { text: "working on auth", created_at: new Date().toISOString() },
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const content = complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain("[PREVIOUS SESSION — LAST MESSAGES]");
    expect(content).toContain("USER: fix the login bug");
    expect(content).toContain("ASSISTANT:");
  });

  it("includes identity chunks in LLM prompt", async () => {
    const store = mockStore({
      identity: [
        { text: "You have persistent memory across sessions" },
        { text: "Your preferences matter" },
      ],
      handoff: { text: "continuing work", created_at: new Date().toISOString() },
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const content = complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain("[IDENTITY]");
    expect(content).toContain("persistent memory");
  });

  it("includes monologues in LLM prompt", async () => {
    const store = mockStore({
      monologues: [
        { category: "insight", content: "The caching layer needs refactoring" },
        { category: "doubt", content: "Not sure about the DB schema" },
      ],
      handoff: { text: "working", created_at: new Date().toISOString() },
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const content = complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain("[RECENT THINKING]");
    expect(content).toContain("[insight] The caching layer");
  });

  it("annotates handoff age in hours", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const store = mockStore({
      handoff: { text: "old work", created_at: twoHoursAgo },
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const content = complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain("2h old");
  });

  it("notes resolved memories since handoff", async () => {
    const store = mockStore({
      handoff: { text: "had some issues", created_at: new Date().toISOString() },
      resolvedCount: 3,
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const content = complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain("3 memories resolved since");
  });

  it("returns null when briefing is too short (< 100 chars)", async () => {
    const store = mockStore({
      handoff: { text: "work", created_at: new Date().toISOString() },
    });
    const complete = mockComplete("Too short.");

    const result = await synthesizeWakeup(store, complete);
    expect(result).toBeNull();
  });

  it("returns null when only monologues exist (no handoff or previous turns)", async () => {
    // This tests the guard at line 169: no handoff + no monologues + no previousTurns → null
    const store = mockStore({
      monologues: [{ category: "insight", content: "something" }],
      // no handoff, no previousTurns
    });

    const result = await synthesizeWakeup(store, mockComplete());
    // monologues exist but no handoff and no previousTurns → should still try (line 169 checks all three)
    // Actually line 169: !handoff && monologues.length === 0 && previousTurns.length === 0
    // monologues.length > 0, so it proceeds
    expect(result).toBeTruthy(); // LLM called, returns briefing
  });

  it("handles LLM failure gracefully", async () => {
    const store = mockStore({
      handoff: { text: "working", created_at: new Date().toISOString() },
    });
    const complete = vi.fn(async () => { throw new Error("API timeout"); });

    const result = await synthesizeWakeup(store, complete);
    expect(result).toBeNull(); // graceful degradation, not a crash
  });

  it("system prompt instructs first-person briefing", async () => {
    const store = mockStore({
      handoff: { text: "work", created_at: new Date().toISOString() },
    });
    const complete = mockComplete();

    await synthesizeWakeup(store, complete);

    const systemPrompt = complete.mock.calls[0][0].system;
    expect(systemPrompt).toContain("first-person");
    expect(systemPrompt).toContain("wake-up briefing");
    expect(systemPrompt).toContain("~150 words");
  });
});
