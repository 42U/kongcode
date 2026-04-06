/**
 * TaskCreated + SubagentStop hook handlers.
 *
 * Tracks spawned subagents and their lifecycle.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";

export async function handleTaskCreated(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  // TODO: Phase 5 will add subagent tracking
  return {};
}

export async function handleSubagentStop(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  // TODO: Phase 5 will add subagent summary
  return {};
}
