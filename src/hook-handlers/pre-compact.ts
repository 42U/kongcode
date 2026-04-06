/**
 * PreCompact hook handler.
 *
 * Before Claude Code compacts the conversation, extract and preserve
 * critical context that would otherwise be lost: pending work,
 * key files, tool usage, recent errors.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";

export async function handlePreCompact(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  // TODO: Phase 4 will add:
  // - Extract pending work (regex: "todo", "next", "pending")
  // - Key files mentioned (.ts, .js, .md, etc.)
  // - Tool usage summary
  // - Recent errors
  // - Return as systemMessage for context preservation

  return {};
}
