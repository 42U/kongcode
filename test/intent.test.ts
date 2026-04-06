import { describe, it, expect } from "vitest";
import { estimateComplexity } from "../src/intent.js";
import type { IntentResult } from "../src/intent.js";

function mockIntent(category: string, confidence = 0.9): IntentResult {
  return { category: category as any, confidence, scores: [] };
}

describe("estimateComplexity", () => {
  it("simple-question is trivial with no tools", () => {
    const result = estimateComplexity("What is a linked list?", mockIntent("simple-question"));
    expect(result.level).toBe("trivial");
    expect(result.estimatedToolCalls).toBe(0);
    expect(result.suggestedThinking).toBe("low");
  });

  it("code-write is moderate with high thinking", () => {
    const result = estimateComplexity("Write a sort function", mockIntent("code-write"));
    expect(result.level).toBe("moderate");
    expect(result.suggestedThinking).toBe("high");
    expect(result.estimatedToolCalls).toBeGreaterThan(0);
  });

  it("code-debug is moderate with high thinking", () => {
    const result = estimateComplexity("Fix the TypeError in auth.ts", mockIntent("code-debug"));
    expect(result.level).toBe("moderate");
    expect(result.suggestedThinking).toBe("high");
  });

  it("deep-explore is deep", () => {
    const result = estimateComplexity("Analyze every file in the codebase", mockIntent("deep-explore"));
    expect(result.level).toBe("deep");
    expect(result.estimatedToolCalls).toBe(20);
  });

  it("multi-step keywords escalate complexity", () => {
    const result = estimateComplexity(
      "First refactor auth, then update the tests, finally deploy",
      mockIntent("code-write"),
    );
    expect(result.level).toBe("complex");
    expect(result.suggestedThinking).toBe("high");
    expect(result.estimatedToolCalls).toBeGreaterThanOrEqual(12);
  });

  it("'every'/'all' keywords escalate to deep", () => {
    const result = estimateComplexity(
      "Check every endpoint in the entire API",
      mockIntent("code-read"),
    );
    expect(result.level).toBe("deep");
    expect(result.estimatedToolCalls).toBeGreaterThanOrEqual(20);
  });

  it("long text (>100 words) increases tool budget for code intents", () => {
    const longText = "Please " + "analyze this specific code pattern and ".repeat(20) + "report back.";
    const result = estimateComplexity(longText, mockIntent("code-read"));
    expect(result.estimatedToolCalls).toBeGreaterThanOrEqual(12);
  });

  it("continuation is simple", () => {
    const result = estimateComplexity("yes go ahead", mockIntent("continuation"));
    expect(result.level).toBe("simple");
  });

  it("meta-session is trivial", () => {
    const result = estimateComplexity("What have we worked on?", mockIntent("meta-session"));
    expect(result.level).toBe("trivial");
    expect(result.suggestedThinking).toBe("low");
  });

  it("unknown falls back to moderate", () => {
    const result = estimateComplexity("asdfghjkl", mockIntent("unknown"));
    expect(result.level).toBe("moderate");
    expect(result.suggestedThinking).toBe("medium");
  });
});
