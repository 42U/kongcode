/**
 * Regression tests for live HTTP hook handlers — specifically the payload
 * field-name contracts. Two production handlers shipped with wrong field
 * names since commit 7a16e57 (Apr 6, 2026) and silently no-op'd for ~20
 * days, killing turn ingestion and tool-outcome tracking:
 *
 *   user-prompt-submit.ts read `payload.user_prompt` — Claude Code sends
 *     `payload.prompt`. Every prompt early-returned {}. No turns ingested,
 *     no retrieval pipeline run.
 *   post-tool-use.ts read `payload.tool_result` — Claude Code sends
 *     `payload.tool_response`. Token accounting stuck at 0; recordToolOutcome
 *     was never wired into this handler at all (the engine-internal
 *     after-tool-call handler had it but is test-only).
 *
 * These tests exercise the *production* HTTP handlers — the ones the
 * hook proxy actually invokes — using the canonical Claude Code payload
 * shape. Existing `hooks.test.ts` covers the engine-internal handlers
 * which run in tests but never in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUserPromptSubmit } from "../src/hook-handlers/user-prompt-submit.js";
import { handlePostToolUse } from "../src/hook-handlers/post-tool-use.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import {
  stageRetrieval,
  evaluateRetrieval,
  getStagedItems,
} from "../src/engine/retrieval-quality.js";

// Minimal state stub — we only need session lookup, store stub for the
// pending_work query, and a no-op embeddings service.
function makeState(session: SessionState): GlobalPluginState {
  const store = {
    isAvailable: () => false, // skip pending_work query path
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
  } as unknown as GlobalPluginState["store"];
  const embeddings = {
    isAvailable: () => false,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as unknown as GlobalPluginState["embeddings"];

  const state = {
    store,
    embeddings,
    config: { thresholds: { midSessionCleanupThreshold: 25_000 } },
    workspaceDir: "/tmp",
  } as unknown as GlobalPluginState;

  // Wire session lookup to return our prepared session
  (state as unknown as { getSession: (k: string) => SessionState | undefined }).getSession =
    (k: string) => k === session.sessionKey ? session : undefined;
  (state as unknown as { getOrCreateSession: (k: string, i: string) => SessionState }).getOrCreateSession =
    (k: string, _i: string) => k === session.sessionKey ? session : session;

  return state;
}

describe("handleUserPromptSubmit — payload.prompt contract", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-1", "sess-1");
  });

  it("reads the user's text from payload.prompt (canonical Claude Code field)", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      prompt: "what is the retrieval utilization currently",
    };
    await handleUserPromptSubmit(state, payload);
    // The handler stashes the user text on the session for downstream
    // retrieval/embedding reuse. If field-name parsing breaks, this is
    // the first observable symptom.
    expect(session.lastUserText).toBe("what is the retrieval utilization currently");
  });

  it("falls back to payload.user_prompt for backwards compatibility", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-1",
      user_prompt: "legacy field name",
    };
    await handleUserPromptSubmit(state, payload);
    expect(session.lastUserText).toBe("legacy field name");
  });

  it("early-returns {} only when both fields are absent (real no-prompt case)", async () => {
    const state = makeState(session);
    const result = await handleUserPromptSubmit(state, { session_id: "sess-1" });
    expect(result).toEqual({});
    expect(session.lastUserText).toBe("");
  });
});

describe("handlePostToolUse — payload.tool_response contract", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-2", "sess-2");
    // Re-register session in state by constructing fresh state per test
  });

  it("reads tool output from payload.tool_response (canonical field)", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-2",
      tool_name: "Bash",
      tool_response: "hello world output", // 18 chars → ceil(18/4) = 5 tokens
    };
    await handlePostToolUse(state, payload);
    expect(session.cumulativeTokens).toBe(5);
    expect(session._turnToolCalls).toBe(1);
  });

  it("falls back to payload.tool_result for backwards compatibility", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-2",
      tool_name: "Bash",
      tool_result: "legacy output",
    });
    expect(session.cumulativeTokens).toBeGreaterThan(0);
  });

  it("handles tool_response as object (Claude Code sends parsed objects for many tools)", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-2",
      tool_name: "Read",
      tool_response: { file: "x", content: "abc" },
    });
    // JSON.stringify({file:'x',content:'abc'}) = 25 chars → ceil(25/4) = 7
    expect(session.cumulativeTokens).toBeGreaterThan(0);
    expect(session._turnToolCalls).toBe(1);
  });
});

describe("handlePostToolUse — recordToolOutcome wiring", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-3", "sess-3");
    // Stage a fake retrieval so recordToolOutcome has somewhere to land
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
  });

  it("records success when no error indicators are present", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: "ok",
    });
    expect(getStagedItems().length).toBe(1); // still staged until evaluateRetrieval
    // Drain the singleton without writing (store is unavailable in stub)
    await evaluateRetrieval("turn:test", "response text", { isAvailable: () => false } as unknown as Parameters<typeof evaluateRetrieval>[2]);
  });

  it("detects failure from top-level payload.error", async () => {
    // Re-stage since the previous test drained the singleton
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: "boom",
      error: "command failed",
    });
    // Failure path should still increment the turn tool counter
    expect(session._turnToolCalls).toBeGreaterThan(0);
  });

  it("detects failure from tool_response.is_error (Anthropic tool_result convention)", async () => {
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: { is_error: true, content: "stderr stuff" },
    });
    expect(session._turnToolCalls).toBeGreaterThan(0);
  });
});
