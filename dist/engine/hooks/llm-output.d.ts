/**
 * llm_output hook — token tracking, text length accumulation,
 * dynamic budget parsing, and cognitive check triggering.
 */
import type { GlobalPluginState } from "../state.js";
export declare function createLlmOutputHandler(state: GlobalPluginState): (event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
}, ctx: {
    sessionKey?: string;
    sessionId?: string;
}) => Promise<void>;
