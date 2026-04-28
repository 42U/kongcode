/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
export declare function handlePreToolUse(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
