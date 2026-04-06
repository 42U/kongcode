/**
 * before_tool_call hook — planning gate + tool limit enforcement.
 *
 * - Planning gate: model must output text before its first tool call
 * - Tool limit: blocks when budget exceeded
 * - Soft interrupt: blocks when user pressed Ctrl+C
 */

import type { GlobalPluginState } from "../state.js";
import { recordToolCall } from "../orchestrator.js";
import { cosineSimilarity } from "../graph-context.js";

const DEFAULT_TOOL_LIMIT = 9;
const CLASSIFICATION_LIMITS: Record<string, number> = { LOOKUP: 3, EDIT: 4, REFACTOR: 8 };
const API_CYCLE_CAP = 16;
const RECALL_SIMILARITY_THRESHOLD = 0.80;

export function createBeforeToolCallHandler(state: GlobalPluginState) {
  return async (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      runId?: string;
      toolCallId?: string;
      assistantTextLengthSoFar?: number;
      toolCallIndexInTurn?: number;
    },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
    const session = state.getSession(sessionKey);
    if (!session) return;

    session.toolCallCount++;
    session.toolCallsSinceLastText++;
    session.apiCycleCount++;

    // Record for steering analysis
    recordToolCall(session, event.toolName);

    // Use native fields when available, fall back to plugin-tracked state
    const textLengthSoFar = event.assistantTextLengthSoFar ?? session.turnTextLength;
    const toolIndex = event.toolCallIndexInTurn ?? (session.toolCallCount - 1);

    // Soft interrupt
    if (session.softInterrupted) {
      return {
        block: true,
        blockReason: "The user pressed Ctrl+C to interrupt you. Stop all tool calls immediately. Summarize what you've found so far, respond to the user with your current progress, and ask how to proceed.",
      };
    }

    // API cycle cap (claw-code pattern: max_iterations — conversation.rs:119)
    if (session.apiCycleCount > API_CYCLE_CAP) {
      return {
        block: true,
        blockReason: `Hard API cycle cap (${API_CYCLE_CAP}) reached. Deliver your answer now.`,
      };
    }

    // Tool limit
    if (session.toolCallCount >= session.toolLimit) {
      return {
        block: true,
        blockReason: `Tool call limit reached (${session.toolLimit}). Stop calling tools. Continue exactly where you left off — deliver your answer from what you've gathered. Do NOT repeat anything you already said. State what's done and what remains.`,
      };
    }

    // Intent-based tool gating (claw-code pattern: simple_mode/MCP toggle — tools.py:62-72)
    // On skipRetrieval turns, recall has nothing to add — context was skipped intentionally
    if (event.toolName === "recall" && session.currentConfig?.skipRetrieval) {
      return {
        block: true,
        blockReason: "Context retrieval was skipped this turn (continuation/trivial input). " +
          "Recall would return the same results as previous turns. Continue with what you have.",
      };
    }

    // Redundant recall blocker (claw-code pattern: _infer_permission_denials — runtime.py:169-174)
    // Block recall when its query would return the same results as context retrieval
    if (event.toolName === "recall" && session.lastQueryVec) {
      const recallQuery = (event.params as { query?: string }).query;
      if (recallQuery && typeof recallQuery === "string" && recallQuery.length > 5) {
        try {
          const recallVec = await state.embeddings.embed(recallQuery);
          const sim = cosineSimilarity(session.lastQueryVec, recallVec);
          if (sim > RECALL_SIMILARITY_THRESHOLD) {
            return {
              block: true,
              blockReason:
                `This recall query is ${(sim * 100).toFixed(0)}% similar to the context already retrieved this turn. ` +
                "The results are in <graph_context> above. Read what you have. " +
                "Only call recall with a DIFFERENT query targeting something specific not already covered.",
            };
          }
        } catch { /* fail-open: allow recall if embedding fails */ }
      }
    }

    // Planning gate: model must output text before first tool call
    if (textLengthSoFar === 0 && toolIndex === 0) {
      const retrievalNote = session.lastRetrievalSummary
        ? ` Context: ${session.lastRetrievalSummary}.`
        : "";
      return {
        block: true,
        blockReason:
          "Plan before tools. Classify (LOOKUP/EDIT/REFACTOR), state what you know from <graph_context>," +
          " list each call + what gap it fills. Combine steps. 0 calls if context answers it." +
          retrievalNote,
      };
    }

    // Inline classification: if text was emitted with a classification keyword,
    // parse and apply the tool limit (even on first tool call after text)
    if (toolIndex === 0 && textLengthSoFar > 0 && session.toolLimit === DEFAULT_TOOL_LIMIT) {
      const parsed = parseClassificationFromText(session.lastAssistantText ?? "");
      if (parsed !== null) {
        session.toolLimit = parsed;
      }
    }

    return undefined;
  };
}

/**
 * Parse LOOKUP/EDIT/REFACTOR classification from planning gate response.
 * Called from llm_output to dynamically adjust tool limit.
 */
export function parseClassificationFromText(text: string): number | null {
  const match = text.match(/\b(LOOKUP|EDIT|REFACTOR)\b/);
  if (match && CLASSIFICATION_LIMITS[match[1]]) {
    return CLASSIFICATION_LIMITS[match[1]];
  }
  return null;
}
