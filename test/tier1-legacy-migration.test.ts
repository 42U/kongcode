/**
 * v0.8.5 one-shot migration: retire tier-1 rows stamped with the
 * pre-unification relay identity (`mcp-client-<pid>`).
 *
 * Until v0.8.5 the MCP relay sent `mcp-client-<pid>` as its session id while
 * the context renderer keyed on Claude Code's session UUID. Once tier-1 reads
 * became session-scoped those rows could never match a live session again — so
 * they would have gone *quietly* invisible, including user-set safety rules.
 * The migration archives them explicitly instead.
 *
 * Runs against a live throwaway SurrealDB: the predicate uses
 * `string::starts_with`, which THROWS on a NONE `session_id` (option<string>,
 * unset on bootstrap-seeded rows), and store.queryExec swallows that — so a
 * missing `session_id != NONE` guard would make the migration a silent no-op
 * that still reports success. Only a real database catches that.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { seedCognitiveBootstrap } from "../src/engine/cognitive-bootstrap.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "laqrum_test";
const TEST_DB = `t1mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let store: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  store = new SurrealStore({
    url,
    get httpUrl() { return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: process.env.SURREAL_USER ?? "root",
    pass: process.env.SURREAL_PASS ?? "root",
    ns: TEST_NS, db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 10_000)),
    ]);
  } catch { store = undefined as never; }
}, 15_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

describe("legacy tier-1 session-id migration", () => {
  it("archives mcp-client-* rows, keeps global and current-session ones", async () => {
    if (SKIP || !store?.isAvailable()) return;

    await store.createCoreMemory("legacy pin A", "rules", 100, 1, "mcp-client-1844630");
    await store.createCoreMemory("legacy pin B", "operations", 90, 1, "mcp-client-2682608");
    await store.createCoreMemory("global bootstrap pin", "tools", 80, 1); // no session_id
    await store.createCoreMemory("current session pin", "rules", 95, 1, "ac60ada8-uuid-style");
    await store.createCoreMemory("a tier-0 rule", "rules", 99, 0, "mcp-client-9999"); // wrong tier

    await seedCognitiveBootstrap(store, { isAvailable: () => false } as never);

    const active = await store.getAllCoreMemory(1);
    const texts = active.map((e) => e.text).sort();
    expect(texts).toEqual(["current session pin", "global bootstrap pin"]);

    // Archived EXPLICITLY with a reason, not merely deactivated — the point of
    // the migration is that these rows do not vanish without a trace.
    const archived = await store.queryFirst<{ text: string }>(
      `SELECT text FROM core_memory WHERE archive_reason = 'tier1_session_id_space_unified_v0.8.5'`,
    );
    expect(archived.map((r) => r.text).sort()).toEqual(["legacy pin A", "legacy pin B"]);

    // Tier 0 must be untouched even when it carries a legacy-looking session id.
    const t0 = await store.getAllCoreMemory(0);
    expect(t0.map((e) => e.text)).toContain("a tier-0 rule");
  }, 30_000);

  it("is idempotent — a second run archives nothing new and throws nothing", async () => {
    if (SKIP || !store?.isAvailable()) return;
    const before = (await store.getAllCoreMemory(1)).length;
    await seedCognitiveBootstrap(store, { isAvailable: () => false } as never);
    expect((await store.getAllCoreMemory(1)).length).toBe(before);
  }, 30_000);
});
