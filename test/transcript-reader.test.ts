/**
 * Tests for the Claude Code transcript reader.
 *
 * Stop hook uses this to recover the assistant's response text — without
 * it, retrieval_outcome rows stop being written (Apr 15 → Apr 26 outage).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLatestAssistantText } from "../src/engine/transcript-reader.js";

const SAMPLE_LINES = [
  { type: "user", message: { role: "user", content: "first prompt" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "first reply" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final assistant reply text" }],
    },
  },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kongcode-transcript-"));
  path = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLatestAssistantText", () => {
  it("returns the latest assistant message text from a JSONL transcript", () => {
    writeFileSync(path, SAMPLE_LINES.map(l => JSON.stringify(l)).join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("final assistant reply text");
  });

  it("joins multiple text blocks within an assistant message with newlines", () => {
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "tool_use", id: "x" },
          { type: "text", text: "part two" },
        ],
      },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("part one\npart two");
  });

  it("returns empty string when transcript has no assistant text", () => {
    writeFileSync(path, JSON.stringify({
      type: "user",
      message: { role: "user", content: "only a user prompt" },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("");
  });

  it("returns empty string when path is missing or unreadable", () => {
    expect(readLatestAssistantText("")).toBe("");
    expect(readLatestAssistantText("/nonexistent/path/x.jsonl")).toBe("");
  });

  it("ignores malformed JSON lines and recovers good ones", () => {
    writeFileSync(path, [
      "{not valid json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "good text" }] } }),
      "another garbage line",
      "",
    ].join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("good text");
  });

  it("handles assistant message with string content (not an array)", () => {
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "plain string content" },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("plain string content");
  });

  it("only keeps assistant messages — tool_result blocks in user messages are ignored", () => {
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real reply" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "tool output text" }] } }),
    ].join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("real reply");
  });
});
