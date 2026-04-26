/**
 * Claude Code transcript reader.
 *
 * Stop hook needs the assistant's response text to evaluate retrieval
 * utilization (text overlap with retrieved items). The Stop payload itself
 * doesn't carry the response — only `transcript_path` to the JSONL file
 * Claude Code writes turn by turn. This module pulls the latest assistant
 * text from that file.
 *
 * Why this exists: previously the Stop hook read `session.lastAssistantText`,
 * but nothing in the production hook chain ever set that field — the
 * llm-output engine handler that populates it is test-only, never wired.
 * As a result, `evaluateRetrieval` always early-returned (no turn id, no
 * response text) and `retrieval_outcome` writes silently stopped on
 * Apr 15. This reader closes that loop.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

const READ_TAIL_BYTES = 256 * 1024; // 256 KB tail is enough for the last assistant turn

interface TranscriptMessage {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Read the latest assistant message text from a Claude Code transcript.
 *
 * Reads only the file's tail (256 KB) for performance. Returns "" if
 * the file is missing, unreadable, or contains no assistant message
 * with text content.
 */
export function readLatestAssistantText(transcriptPath: string): string {
  if (!transcriptPath) return "";
  let raw: string;
  try {
    const stats = statSync(transcriptPath);
    if (stats.size > READ_TAIL_BYTES) {
      // Read tail only — open + seek + read window
      const buf = Buffer.alloc(READ_TAIL_BYTES);
      const fd = openSync(transcriptPath, "r");
      try {
        readSync(fd, buf, 0, READ_TAIL_BYTES, stats.size - READ_TAIL_BYTES);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString("utf-8");
      // Drop the (likely partial) first line
      const nl = raw.indexOf("\n");
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = readFileSync(transcriptPath, "utf-8");
    }
  } catch {
    return "";
  }

  let latestText = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: TranscriptMessage;
    try {
      obj = JSON.parse(line) as TranscriptMessage;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const content = obj.message?.content;
    const text = extractAssistantText(content);
    if (text) latestText = text; // keep updating; last one wins
  }
  return latestText;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: string }).text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.join("\n");
}
