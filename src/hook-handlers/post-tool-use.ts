/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training, tracks artifact mutations,
 * triggers daemon extraction if token threshold is reached.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";

export async function handlePostToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  // TODO: Phase 4 will add:
  // - Tool outcome recording
  // - Artifact extraction from file operations (Write, Edit paths)
  // - Daemon flush trigger if token threshold met

  return {};
}
