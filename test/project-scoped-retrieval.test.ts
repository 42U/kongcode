import { describe, it, expect, vi } from "vitest";
import { createIntrospectToolDef } from "../src/engine/tools/introspect.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

/** Regression for v0.7.26 project-scoped retrieval.
 *
 * Before this release, vectorSearch ignored session.projectId, so retrieval
 * pulled concepts/memories from every project the agent had ever worked on.
 * The reflection_context block was the loudest bleed source. Phase 1 wires
 * project_id through the write path (commitKnowledge) and adds an optional
 * filter on the read path (vectorSearch + retrieveReflections). This test
 * pins the backfill migration shape — the schema-side change is verified
 * via the shape of the SurrealQL queryFirst calls. */
describe("introspect.action=migrate, filter=backfill_project_id", () => {
  function makeState(opts: {
    conceptOrphans: { id: string; project_id: string }[];
    memoryOrphans: { id: string; project_id: string }[];
  }) {
    const updateCalls: { id: string; pid: string }[] = [];
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM concept") && sql.includes("project_id IS NONE") && sql.includes("relevant_to")) {
        return opts.conceptOrphans;
      }
      if (sql.includes("FROM memory") && sql.includes("project_id IS NONE") && sql.includes("session_id IS NOT NONE")) {
        return opts.memoryOrphans;
      }
      return [];
    });
    const queryExec = vi.fn().mockImplementation(async (sql: string, params: any) => {
      const m = sql.match(/UPDATE (\S+) SET project_id/);
      if (m && params?.pid) updateCalls.push({ id: m[1], pid: String(params.pid) });
    });
    const state: Partial<GlobalPluginState> = {
      store: { isAvailable: () => true, queryFirst, queryExec } as any,
    };
    const session: Partial<SessionState> = { sessionId: "test-session" };
    return { state, session, updateCalls };
  }

  it("backfills concept project_id from outgoing relevant_to edge", async () => {
    const { state, session, updateCalls } = makeState({
      conceptOrphans: [
        { id: "concept:abc", project_id: "project:p1" },
        { id: "concept:def", project_id: "project:p2" },
      ],
      memoryOrphans: [],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_project_id" });
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]).toEqual({ id: "concept:abc", pid: "project:p1" });
    expect(updateCalls[1]).toEqual({ id: "concept:def", pid: "project:p2" });
    expect((result as any).details.concepts).toEqual({ found: 2, fixed: 2 });
  });

  it("backfills memory project_id via session traversal", async () => {
    const { state, session, updateCalls } = makeState({
      conceptOrphans: [],
      memoryOrphans: [{ id: "memory:m1", project_id: "project:p1" }],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_project_id" });
    expect(updateCalls).toEqual([{ id: "memory:m1", pid: "project:p1" }]);
    expect((result as any).details.memories).toEqual({ found: 1, fixed: 1 });
  });

  it("is idempotent — orphan queries already filter project_id IS NONE", async () => {
    const { state, session, updateCalls } = makeState({
      conceptOrphans: [],
      memoryOrphans: [],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_project_id" });
    expect(updateCalls).toHaveLength(0);
    // 0.7.29: details shape extended to all 6 backfill-eligible tables.
    expect((result as any).details).toMatchObject({
      tasks: { found: 0, fixed: 0 },
      sessions: { found: 0, fixed: 0 },
      concepts: { found: 0, fixed: 0 },
      memories: { found: 0, fixed: 0 },
      reflections: { found: 0, fixed: 0 },
      skills: { found: 0, fixed: 0 },
    });
  });

  it("skips rows where project_id resolved to falsy (no session, broken edge)", async () => {
    const { state, session, updateCalls } = makeState({
      conceptOrphans: [
        { id: "concept:abc", project_id: "project:p1" },
        { id: "concept:def", project_id: "" }, // broken edge
      ],
      memoryOrphans: [],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_project_id" });
    expect(updateCalls).toHaveLength(1);
    expect((result as any).details.concepts).toEqual({ found: 2, fixed: 1 });
  });
});
