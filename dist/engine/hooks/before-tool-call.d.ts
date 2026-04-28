/**
 * before_tool_call hook — planning gate + tool limit enforcement.
 *
 * - Planning gate: model must output text before its first tool call
 * - Tool limit: blocks when budget exceeded
 * - Soft interrupt: blocks when user pressed Ctrl+C
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
