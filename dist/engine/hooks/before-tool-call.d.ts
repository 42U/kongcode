/**
 * before_tool_call hook — planning gate + tool limit enforcement.
 *
 * - Planning gate: model must output text before its first tool call
 * - Tool limit: blocks when budget exceeded
 * - Soft interrupt: blocks after the loop guard trips (many tool calls with no
 *   output). NOT a user Ctrl+C; nothing sets softInterrupted from a real user
 *   interrupt.
 *
 * NOTE: this module is not wired into the Claude Code plugin path — it is
 * imported only by test/optimization.test.ts, and daemon/index.ts does not
 * register it (same test-only status already documented for llm-output.ts in
 * stop.ts and transcript-reader.ts). It is therefore the only consumer of
 * session.softInterrupted, and that consumer never runs in production: today
 * the flag's sole live effect is making the pre-tool-use gate fire once per
 * turn rather than on every call. See #20.
 */
import type { GlobalPluginState } from "../state.js";
export declare function createBeforeToolCallHandler(state: GlobalPluginState): (event: {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    assistantTextLengthSoFar?: number;
    toolCallIndexInTurn?: number;
}, ctx: {
    sessionKey?: string;
    sessionId?: string;
}) => Promise<{
    block: boolean;
    blockReason: string;
} | undefined>;
/**
 * Parse LOOKUP/EDIT/REFACTOR classification from planning gate response.
 * Called from llm_output to dynamically adjust tool limit.
 */
export declare function parseClassificationFromText(text: string): number | null;
