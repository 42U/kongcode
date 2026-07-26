/**
 * Issue #20 — the planning gate must fire on SILENCE, not on volume of work.
 *
 * The counter it keys on had no producer: the only code that reset it on
 * assistant text (engine/hooks/llm-output.ts) is test-only, and Claude Code's
 * hook surface has no assistant-text event, so it stayed equal to the raw tool
 * count and the gate fired during long, legitimate investigations.
 *
 * The count is now derived from the transcript. These tests use synthetic
 * JSONL so they are deterministic and need neither a live transcript nor a
 * database — the previous round's live-DB tests reported green in CI while
 * asserting nothing, and that is not repeated here.
 *
 * Transcript shape is taken from a real Claude Code file: every content block
 * is its OWN `assistant` entry (text / thinking / tool_use), and a tool's
 * output comes back as a `user` entry carrying tool_result blocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countToolCallsSinceText,
  deriveTranscriptPath,
} from "../src/engine/transcript-reader.js";
import { handlePreToolUse } from "../src/hook-handlers/pre-tool-use.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kc-loop-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

const text = (s: string) => ({ type: "assistant", message: { content: [{ type: "text", text: s }] } });
const thinking = () => ({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } });
const toolUse = () => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
const toolResult = () => ({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
const userSays = (s: string) => ({ type: "user", message: { content: [{ type: "text", text: s }] } });
const NARRATION = "x".repeat(60); // over the 50-char narration threshold

function transcript(...entries: unknown[]): string {
  const p = join(dir, "t.jsonl");
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

describe("countToolCallsSinceText", () => {
  it("counts tool calls made since the model last narrated", () => {
    const p = transcript(text(NARRATION), toolUse(), toolResult(), toolUse(), toolResult());
    expect(countToolCallsSinceText(p)).toBe(2);
  });

  it("resets when the model narrates again — the whole point of the fix", () => {
    const p = transcript(
      toolUse(), toolResult(), toolUse(), toolResult(), toolUse(), toolResult(),
      text(NARRATION),
      toolUse(), toolResult(),
    );
    expect(countToolCallsSinceText(p)).toBe(1);
  });

  it("does NOT reset on thinking — thinking happens inside loops too", () => {
    const p = transcript(text(NARRATION), toolUse(), thinking(), toolUse(), thinking(), toolUse());
    expect(countToolCallsSinceText(p)).toBe(3);
  });

  it("does NOT reset on a tool_result, which arrives as a `user` entry", () => {
    // Treating tool_result as user input would reset on every single call and
    // silently disable the gate entirely.
    const p = transcript(text(NARRATION), toolUse(), toolResult(), toolUse(), toolResult(), toolUse());
    expect(countToolCallsSinceText(p)).toBe(3);
  });

  it("resets on a real user turn", () => {
    const p = transcript(toolUse(), toolUse(), toolUse(), userSays("next task"), toolUse());
    expect(countToolCallsSinceText(p)).toBe(1);
  });

  it("ignores narration below the threshold — 'Ok.' is not progress", () => {
    const p = transcript(text(NARRATION), toolUse(), text("Ok."), toolUse());
    expect(countToolCallsSinceText(p)).toBe(2);
  });

  it("counts multiple tool_use blocks in one entry", () => {
    const p = transcript(text(NARRATION), {
      type: "assistant",
      message: { content: [{ type: "tool_use" }, { type: "tool_use" }, { type: "tool_use" }] },
    });
    expect(countToolCallsSinceText(p)).toBe(3);
  });

  it("treats a text block accompanying tool_use in one entry as narration", () => {
    const p = transcript({
      type: "assistant",
      message: { content: [{ type: "text", text: NARRATION }, { type: "tool_use" }] },
    });
    expect(countToolCallsSinceText(p)).toBe(1);
  });

  it("fails OPEN on a missing or unreadable transcript", () => {
    // A gate that misfires during real work is worse than one that misses a loop.
    expect(countToolCallsSinceText(join(dir, "nope.jsonl"))).toBe(0);
    expect(countToolCallsSinceText("")).toBe(0);
  });

  it("skips malformed lines instead of aborting the scan", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify(text(NARRATION)),
      "{not json",
      JSON.stringify(toolUse()),
      JSON.stringify(toolUse()),
    ].join("\n"));
    expect(countToolCallsSinceText(p)).toBe(2);
  });
});

describe("deriveTranscriptPath", () => {
  it("maps a cwd to Claude Code's dashed project directory", () => {
    expect(deriveTranscriptPath("uuid-1", "/home/u/proj", "/home/u"))
      .toBe("/home/u/.claude/projects/-home-u-proj/uuid-1.jsonl");
  });

  it("handles Windows-style separators", () => {
    expect(deriveTranscriptPath("uuid-1", "C:\\dev\\proj", "/h"))
      .toBe("/h/.claude/projects/C:-dev-proj/uuid-1.jsonl");
  });

  it("returns empty when any component is missing, so the caller fails open", () => {
    expect(deriveTranscriptPath("", "/a", "/h")).toBe("");
    expect(deriveTranscriptPath("s", "", "/h")).toBe("");
    expect(deriveTranscriptPath("s", "/a", "")).toBe("");
  });
});

describe("the gate itself: silence trips it, narration does not", () => {
  function makeState(session: SessionState): GlobalPluginState {
    const state = {
      store: { isAvailable: () => false },
      embeddings: { isAvailable: () => false },
      config: {},
      workspaceDir: "/tmp",
    } as unknown as GlobalPluginState;
    (state as unknown as { getSession: () => SessionState }).getSession = () => session;
    return state;
  }
  const fired = (r: unknown) => JSON.stringify(r).includes("without producing any output");

  it("does NOT fire for a long turn that keeps narrating", async () => {
    // 30 tool calls, but narration every third one. The old predicate counted
    // 30 and fired; this is the exact shape of a real investigation.
    const entries: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      if (i % 3 === 0) entries.push(text(NARRATION));
      entries.push(toolUse(), toolResult());
    }
    const p = transcript(...entries);
    const session = new SessionState("s", "s");
    session.toolLimit = 10;
    const res = await handlePreToolUse(makeState(session), {
      session_id: "s", tool_name: "Bash", transcript_path: p,
    });
    expect(fired(res)).toBe(false);
    expect(session.softInterrupted).toBe(false);
  });

  it("DOES fire on a genuinely silent run of tool calls", async () => {
    const entries: unknown[] = [text(NARRATION)];
    for (let i = 0; i < 15; i++) entries.push(toolUse(), toolResult());
    const p = transcript(...entries);
    const session = new SessionState("s", "s");
    session.toolLimit = 10;
    const res = await handlePreToolUse(makeState(session), {
      session_id: "s", tool_name: "Bash", transcript_path: p,
    });
    expect(fired(res)).toBe(true);
    expect(session.softInterrupted).toBe(true);
  });

  it("stays quiet when the transcript cannot be found", async () => {
    const session = new SessionState("s", "s");
    session.toolLimit = 1;
    session.toolCallCount = 99;
    const res = await handlePreToolUse(makeState(session), {
      session_id: "s", tool_name: "Bash", transcript_path: join(dir, "missing.jsonl"),
    });
    expect(fired(res)).toBe(false);
  });
});
