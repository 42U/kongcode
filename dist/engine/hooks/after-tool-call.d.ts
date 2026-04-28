/**
 * after_tool_call hook — artifact tracking + tool outcome recording.
 */
import type { GlobalPluginState } from "../state.js";
export declare function createAfterToolCallHandler(state: GlobalPluginState): (event: {
    toolName: string;
    params: Record<string, unknown>;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
}, ctx: {
    sessionKey?: string;
    sessionId?: string;
}) => Promise<void>;
