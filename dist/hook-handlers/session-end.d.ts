/**
 * SessionEnd hook handler.
 *
 * Queues cognitive work (extraction, reflection, skills, soul) to the
 * pending_work table for processing by a subagent on the next session.
 * No LLM calls — all intelligence runs through Claude subagents.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handleSessionEnd(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
