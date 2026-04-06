/**
 * Stop hook handler.
 *
 * Turn boundary marker: ingests the assistant response, updates token
 * counters, triggers daemon extraction if threshold is reached.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";

export async function handleStop(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  // TODO: Phase 4 will add:
  // - Turn ingestion (embed + store in DB)
  // - Token accumulation for daemon/cleanup thresholds
  // - Cognitive check if interval reached
  // - Daemon flush trigger

  return {};
}
