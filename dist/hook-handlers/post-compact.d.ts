/**
 * PostCompact hook handler.
 *
 * Fires AFTER Claude Code shrinks the conversation window.
 * The model just lost context, so we re-retrieve relevant knowledge
 * from the graph and inject it via additionalContext. Also clears
 * injectedSections so the next UserPromptSubmit does a full re-inject.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
export declare function handlePostCompact(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
