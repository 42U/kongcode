/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handlePostToolUse(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
