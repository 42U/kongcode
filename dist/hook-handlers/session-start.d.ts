/**
 * SessionStart hook handler.
 *
 * Bootstraps the session: creates 5-pillar graph nodes, applies schema,
 * synthesizes wakeup briefing, runs deferred cleanup.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
export declare function handleSessionStart(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
