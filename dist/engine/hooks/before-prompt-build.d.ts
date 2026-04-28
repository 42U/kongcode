/**
 * before_prompt_build hook — orchestrator preflight.
 * Classifies intent, adapts retrieval config, sets thinking level.
 */
import type { GlobalPluginState } from "../state.js";
export declare function createBeforePromptBuildHandler(state: GlobalPluginState): (event: {
    prompt: string;
    messages: unknown[];
}, ctx: {
    sessionKey?: string;
    sessionId?: string;
}) => Promise<{
    prependSystemContext: string | undefined;
    thinkingLevel: import("../intent.js").ThinkingLevel;
} | undefined>;
