/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as additionalContext.
 *
 * On the first turn of a new session, also checks for pending background
 * work and instructs Claude to spawn a subagent to process it.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
export declare function handleUserPromptSubmit(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
