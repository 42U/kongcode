/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";

export async function handlePreToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const toolName = payload.tool_name as string;
  session.toolCallCount++;

  // TODO: Phase 4 will add:
  // - Planning gate (block if no text emitted yet)
  // - Tool budget soft interrupt
  // - Redundant recall detection

  return {};
}
