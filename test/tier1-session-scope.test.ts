/**
 * Tier 1 is documented as "pinned for the CURRENT session" but was read with
 * no session filter, and nothing deactivates the rows at SessionEnd. Every
 * tier-1 directive ever written therefore loaded into every later session —
 * including entries whose own text says "this session", and campaign pins for
 * versions that had already shipped.
 *
 * Runs against a live throwaway SurrealDB on purpose: getAllCoreMemory
 * swallows query errors and returns [], so a malformed filter would silently
 * drop ALL session directives instead of failing. That has to break CI, not
 * degrade quietly in a daemon log.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "laqrum_test";
const TEST_DB = `tier1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let store: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  store = new SurrealStore({
    url,
    get httpUrl() { return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: process.env.SURREAL_USER ?? "root",
    pass: process.env.SURREAL_PASS ?? "root",
    ns: TEST_NS,
    db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 10_000)),
    ]);
  } catch {
    store = undefined as never;
  }
}, 15_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => { if (SKIP || !store?.isAvailable()) return; await fn(); }, timeout);
}

describe("getAllCoreMemory — tier 1 is scoped to the asking session", () => {
  itDb("returns the session's own pins plus un-scoped ones, and no other session's", async () => {
    await store.createCoreMemory("mine", "rules", 90, 1, "session-A");
    await store.createCoreMemory("theirs", "rules", 95, 1, "session-B");
    await store.createCoreMemory("global bootstrap", "tools", 80, 1);
    await store.createCoreMemory("a tier-0 rule", "rules", 99, 0);

    const forA = await store.getAllCoreMemory(1, "session-A");
    expect(forA.map((e) => e.text).sort()).toEqual(["global bootstrap", "mine"]);

    // The other session's pin still exists — scoped out of the read, not
    // destroyed. Deleting at SessionEnd would be wrong: Claude Code reuses
    // sessionId across SessionEnd -> SessionStart when a conversation resumes.
    const unscoped = await store.getAllCoreMemory(1);
    expect(unscoped.map((e) => e.text).sort())
      .toEqual(["global bootstrap", "mine", "theirs"]);
  }, 20_000);

  itDb("a session with no pins of its own still gets the un-scoped ones", async () => {
    // Bootstrap-seeded tier-1 rows carry no session_id and must stay global.
    const forNobody = await store.getAllCoreMemory(1, "session-that-never-existed");
    expect(forNobody.map((e) => e.text)).toEqual(["global bootstrap"]);
  }, 20_000);

  itDb("still returns priority DESC, which the budget trim depends on", async () => {
    await store.createCoreMemory("low", "rules", 10, 1, "session-C");
    await store.createCoreMemory("high", "rules", 99, 1, "session-C");
    const priorities = (await store.getAllCoreMemory(1, "session-C")).map((e) => e.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  }, 20_000);

  itDb("tier 0 is unaffected by the session argument", async () => {
    expect((await store.getAllCoreMemory(0)).map((e) => e.text)).toEqual(["a tier-0 rule"]);
  }, 20_000);
});
