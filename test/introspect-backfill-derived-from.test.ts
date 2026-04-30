import { describe, it, expect, vi } from "vitest";
import { createIntrospectToolDef } from "../src/engine/tools/introspect.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

/** Regression for v0.7.23 silent-failure sweep:
 *  pre-fix create_knowledge_gems wrote concept→artifact via derived_from while
 *  the schema declared IN concept OUT task, so RELATE failed silently and
 *  concepts ended up orphaned from their source artifacts. The 0.7.24 backfill
 *  pairs concept.source = "gem:<X>" to artifact.path = "<X>" and re-RELATEs.
 *  This test pins the pairing rule and verifies idempotency. */
describe("introspect.action=migrate, filter=backfill_derived_from", () => {
  function makeState(opts: {
    orphans: { id: string; source: string }[];
    artifacts: Record<string, string>; // path -> id
  }) {
    const relateCalls: { from: string; edge: string; to: string }[] = [];
    const queryFirst = vi.fn().mockImplementation(async (sql: string, params: any) => {
      if (
        sql.includes("FROM concept")
        && sql.includes("source IS NOT NONE")
        && sql.includes("string::starts_with(source, 'gem:')")
      ) {
        return opts.orphans;
      }
      if (sql.includes("FROM artifact") && sql.includes("path = $path")) {
        const id = opts.artifacts[params.path];
        return id ? [{ id }] : [];
      }
      return [];
    });
    const relate = vi.fn().mockImplementation(async (from: string, edge: string, to: string) => {
      relateCalls.push({ from, edge, to });
    });
    const state: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst,
        relate,
      } as any,
    };
    const session: Partial<SessionState> = { sessionId: "test-session" };
    return { state, session, relateCalls };
  }

  it("relates each orphan concept to its source artifact via derived_from", async () => {
    const { state, session, relateCalls } = makeState({
      orphans: [
        { id: "concept:abc", source: "gem:security_audit_2026-04-30" },
        { id: "concept:def", source: "gem:security_audit_2026-04-30" },
        { id: "concept:ghi", source: "gem:other_doc" },
      ],
      artifacts: {
        "security_audit_2026-04-30": "artifact:sec1",
        "other_doc": "artifact:doc1",
      },
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_derived_from" });
    expect(relateCalls).toHaveLength(3);
    expect(relateCalls[0]).toEqual({ from: "concept:abc", edge: "derived_from", to: "artifact:sec1" });
    expect(relateCalls[1]).toEqual({ from: "concept:def", edge: "derived_from", to: "artifact:sec1" });
    expect(relateCalls[2]).toEqual({ from: "concept:ghi", edge: "derived_from", to: "artifact:doc1" });
    expect((result as any).details).toMatchObject({ orphans: 3, fixed: 3, missingArtifact: 0 });
  });

  it("counts orphans whose source artifact is missing instead of failing", async () => {
    const { state, session, relateCalls } = makeState({
      orphans: [
        { id: "concept:abc", source: "gem:exists" },
        { id: "concept:def", source: "gem:vanished" },
      ],
      artifacts: { "exists": "artifact:e1" },
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_derived_from" });
    expect(relateCalls).toHaveLength(1);
    expect((result as any).details).toMatchObject({ orphans: 2, fixed: 1, missingArtifact: 1 });
  });

  it("is idempotent — orphan query already filters concepts that have a derived_from edge", async () => {
    const { state, session, relateCalls } = makeState({
      orphans: [],
      artifacts: { "anything": "artifact:a" },
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", { action: "migrate", filter: "backfill_derived_from" });
    expect(relateCalls).toHaveLength(0);
    expect((result as any).details).toMatchObject({ orphans: 0, fixed: 0 });
  });
});
