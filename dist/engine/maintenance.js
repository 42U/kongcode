/**
 * Background maintenance — fired on MCP boot and on every SessionStart.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent, so it's safe to run on every
 * MCP boot AND on every SessionStart. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */
import { checkACANReadiness } from "./acan.js";
import { swallow } from "./errors.js";
export function runBootstrapMaintenance(state) {
    const { store, embeddings, config } = state;
    Promise.all([
        store.runMemoryMaintenance(),
        store.archiveOldTurns(),
        store.consolidateMemories((text) => embeddings.embed(text)),
        store.garbageCollectMemories(),
        store.purgeStalePendingWork(),
        backfillSessionTurnCounts(state),
        checkACANReadiness(store, config.thresholds.acanTrainingThreshold),
    ]).catch(e => swallow.warn("bootstrap:maintenance", e));
}
/** One-shot reconciliation: every session row pre-0.7.12 has turn_count=0
 *  because the increment lived in Stop and Stop's been flaky. The `turn`
 *  table has the truth — every ingested turn carries its session_id.
 *  Reconstruct turn_count from turn rows for any session with turn_count=0
 *  or NONE. Idempotent (only updates rows where turn_count is missing/zero
 *  AND the turn table has matching rows), so running on every daemon
 *  startup is safe. Cheap: a single grouped query plus N small updates,
 *  where N = sessions-needing-backfill (one-time, drops to ~0 going forward
 *  since 0.7.12+ writes turn_count on UserPromptSubmit). */
async function backfillSessionTurnCounts(state) {
    if (!state.store.isAvailable())
        return;
    try {
        // turn.session_id stores the Claude Code session id (a UUID string), NOT
        // a SurrealDB record id. So we look up the matching session row via the
        // kc_session_id field, not by interpolating into the UPDATE target.
        // (Earlier 0.7.12 attempt did the wrong thing and tripped SurrealDB's
        // SQL parser on UUIDs that contain hex sequences read as arithmetic.)
        const counts = await state.store.queryFirst(`SELECT session_id, count() AS n FROM turn WHERE session_id IS NOT NONE GROUP BY session_id`);
        if (!counts.length)
            return;
        for (const row of counts) {
            if (!row?.session_id || !row?.n)
                continue;
            try {
                await state.store.queryExec(`UPDATE session SET turn_count = $n
            WHERE kc_session_id = $kc
              AND (turn_count == 0 OR turn_count IS NONE)`, { n: row.n, kc: row.session_id });
            }
            catch (e) {
                swallow.warn("maintenance:backfillTurnCount:update", e);
            }
        }
    }
    catch (e) {
        swallow.warn("maintenance:backfillTurnCount", e);
    }
}
