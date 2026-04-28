/**
 * subagent_spawned / subagent_ended hooks — track spawned subagents in the graph.
 *
 * Creates `subagent` records and `spawned` edges (session → subagent).
 * Updates subagent records with outcome on completion.
 */
import { swallow } from "../errors.js";
// ── Handlers ─────────────────────────────────────────────────────────────
export function createSubagentSpawnedHandler(state) {
    return async (event, ctx) => {
        try {
            const store = state.store;
            // Create the subagent record
            const rows = await store.queryFirst(`CREATE subagent CONTENT {
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
        } RETURN id`, {
                run_id: event.runId,
                parent_key: ctx.requesterSessionKey ?? "unknown",
                child_key: event.childSessionKey,
                agent_id: event.agentId ?? "default",
                label: event.label ?? null,
                mode: event.mode ?? "run",
            });
            const subagentId = String(rows[0]?.id ?? "");
            if (!subagentId)
                return;
            // Find the parent's surreal session ID to create the spawned edge.
            // The requesterSessionKey is the OpenClaw session key — we need to
            // find the matching surreal session record.
            if (ctx.requesterSessionKey) {
                // Look up active session state first (fast path)
                const parentSession = state.getSession(ctx.requesterSessionKey);
                if (parentSession?.surrealSessionId) {
                    await store.relate(parentSession.surrealSessionId, "spawned", subagentId);
                }
                else {
                    // Fallback: find the most recent session record that's still active
                    const sessions = await store.queryFirst(`SELECT id FROM session
             WHERE ended_at IS NONE
             ORDER BY started_at DESC LIMIT 1`);
                    if (sessions.length > 0) {
                        await store.relate(String(sessions[0].id), "spawned", subagentId);
                    }
                }
            }
        }
        catch (e) {
            swallow.warn("hook:subagentSpawned", e);
        }
    };
}
export function createSubagentEndedHandler(state) {
    return async (event, ctx) => {
        try {
            const store = state.store;
            // Update the subagent record by run_id
            await store.queryExec(`UPDATE subagent SET
          status = $status,
          outcome = $outcome,
          error = $error,
          reason = $reason,
          ended_at = $ended_at
        WHERE run_id = $run_id`, {
                run_id: event.runId,
                status: event.outcome === "success" ? "completed"
                    : event.reason === "spawn-failed" ? "error"
                        : event.outcome ?? "completed",
                outcome: event.outcome ?? null,
                error: event.error ?? null,
                reason: event.reason ?? null,
                ended_at: event.endedAt ?? new Date().toISOString(),
            });
        }
        catch (e) {
            swallow.warn("hook:subagentEnded", e);
        }
    };
}
