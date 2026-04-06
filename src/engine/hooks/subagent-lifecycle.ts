/**
 * subagent_spawned / subagent_ended hooks — track spawned subagents in the graph.
 *
 * Creates `subagent` records and `spawned` edges (session → subagent).
 * Updates subagent records with outcome on completion.
 */

import type { GlobalPluginState } from "../state.js";
import { swallow } from "../errors.js";

// ── Event shapes (from OpenClaw gateway) ─────────────────────────────────

interface SubagentSpawnedEvent {
  runId: string;
  childSessionKey: string;
  agentId?: string;
  label?: string;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  };
  threadRequested?: boolean;
  mode?: string; // "run" | "session"
}

interface SubagentSpawnedContext {
  runId: string;
  childSessionKey: string;
  requesterSessionKey?: string;
}

interface SubagentEndedEvent {
  targetSessionKey: string;
  targetKind?: string;
  reason?: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId: string;
  endedAt?: string;
  outcome?: string;
  error?: string;
}

interface SubagentEndedContext {
  runId: string;
  childSessionKey: string;
  requesterSessionKey?: string;
}

// ── Handlers ─────────────────────────────────────────────────────────────

export function createSubagentSpawnedHandler(state: GlobalPluginState) {
  return async (event: SubagentSpawnedEvent, ctx: SubagentSpawnedContext) => {
    try {
      const store = state.store;

      // Create the subagent record
      const rows = await store.queryFirst<{ id: string }>(
        `CREATE subagent CONTENT {
          run_id: $run_id,
          parent_session_key: $parent_key,
          child_session_key: $child_key,
          parent_session_id: $parent_key,
          child_session_id: $child_key,
          agent_id: $agent_id,
          label: $label,
          mode: $mode,
          task: $label,
          status: "running",
          created_at: time::now()
        } RETURN id`,
        {
          run_id: event.runId,
          parent_key: ctx.requesterSessionKey ?? "unknown",
          child_key: event.childSessionKey,
          agent_id: event.agentId ?? "default",
          label: event.label ?? null,
          mode: event.mode ?? "run",
        },
      );

      const subagentId = String(rows[0]?.id ?? "");
      if (!subagentId) return;

      // Find the parent's surreal session ID to create the spawned edge.
      // The requesterSessionKey is the OpenClaw session key — we need to
      // find the matching surreal session record.
      if (ctx.requesterSessionKey) {
        // Look up active session state first (fast path)
        const parentSession = state.getSession(ctx.requesterSessionKey);
        if (parentSession?.surrealSessionId) {
          await store.relate(parentSession.surrealSessionId, "spawned", subagentId);
        } else {
          // Fallback: find the most recent session record that's still active
          const sessions = await store.queryFirst<{ id: string }>(
            `SELECT id FROM session
             WHERE ended_at IS NONE
             ORDER BY started_at DESC LIMIT 1`,
          );
          if (sessions.length > 0) {
            await store.relate(String(sessions[0].id), "spawned", subagentId);
          }
        }
      }
    } catch (e) {
      swallow.warn("hook:subagentSpawned", e);
    }
  };
}

export function createSubagentEndedHandler(state: GlobalPluginState) {
  return async (event: SubagentEndedEvent, ctx: SubagentEndedContext) => {
    try {
      const store = state.store;

      // Update the subagent record by run_id
      await store.queryExec(
        `UPDATE subagent SET
          status = $status,
          outcome = $outcome,
          error = $error,
          reason = $reason,
          ended_at = $ended_at
        WHERE run_id = $run_id`,
        {
          run_id: event.runId,
          status: event.outcome === "success" ? "completed"
            : event.reason === "spawn-failed" ? "error"
            : event.outcome ?? "completed",
          outcome: event.outcome ?? null,
          error: event.error ?? null,
          reason: event.reason ?? null,
          ended_at: event.endedAt ?? new Date().toISOString(),
        },
      );
    } catch (e) {
      swallow.warn("hook:subagentEnded", e);
    }
  };
}
