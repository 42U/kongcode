/**
 * Stop hook handler.
 *
 * Turn boundary marker: ingests the assistant response, updates token
 * counters, and evaluates retrieval quality.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handleStop(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
