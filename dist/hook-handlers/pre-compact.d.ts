/**
 * PreCompact hook handler.
 *
 * Fires BEFORE Claude Code shrinks the conversation window.
 * Ingests any pending turns into SurrealDB before they're lost.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handlePreCompact(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
