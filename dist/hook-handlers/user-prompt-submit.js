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
import { makeHookOutput } from "../http-api.js";
import { assembleContextString, ingestTurn } from "../context-assembler.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { detectAnomalies, formatAnomalyBlock } from "../engine/observability.js";
/** Wrap raw kongcode context in a system-reminder block so Claude treats it
 * as authoritative. Claude Code's harness gives system-reminder blocks higher
 * attention weight than plain injected text — empirically the plain-text
 * injection was hitting ~10% retrieval utilization because the model read it
 * as ambient noise. */
function wrapKongcodeContext(raw) {
    if (!raw || !raw.trim())
        return raw ?? "";
    // Strip any pre-existing <system-reminder>...</system-reminder> blocks from the
    // input before re-wrapping. Without this, kongcode's wrapper ends up nested
    // inside Claude Code's harness wrapper (or a prior hook's wrapper), which
    // shows visibly to the model and suggests sloppy concatenation.
    const stripped = raw
        .replace(/<\/?system-reminder>\s*/g, "")
        .trim();
    if (!stripped)
        return "";
    return [
        "<system-reminder>",
        "KONGCODE CONTEXT — authoritative for this turn.",
        "Before your first text output or tool call, scan the items below.",
        "Items are tagged [load-bearing] / [supporting] or untagged (background).",
        "Items tagged [load-bearing] must be grounded on or explicitly note why",
        "not. Items tagged [supporting] should be mentioned if applicable.",
        "Untagged items are background — skip unless directly relevant; do not",
        "pad responses with them. If you ground on an item, cite by its [#N]",
        "index (e.g. [#3]); the substrate maps the index back to the source.",
        "If no items are relevant, explicitly note that rather than pretending",
        "they aren't there.",
        "",
        stripped,
        "</system-reminder>",
    ].join("\n");
}
export async function handleUserPromptSubmit(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId) ?? state.getOrCreateSession(sessionId, sessionId);
    // Reset per-turn state
    session.resetTurn();
    // Backfill DB rows for resumed sessions. Claude Code does not refire
    // SessionStart on `claude --resume`, so without this every resumed
    // conversation lacks a session row — turns ingested OK but unattributable
    // (session.turn_count stays at 0, graduation thresholds undercount, the
    // X-close orphan pattern persists). ensureSessionRow is idempotent so
    // SessionStart can still own first-fire and this just no-ops on warm
    // sessions.
    if (state.store.isAvailable() && !session.surrealSessionId) {
        try {
            if (!session.agentId) {
                session.agentId = await state.store.ensureAgent("kongcode", "claude");
            }
            session.surrealSessionId = await state.store.ensureSessionRow(session.sessionId, session.agentId, session.projectId || undefined);
            log.info(`[user-prompt-submit] backfilled session row for ${sessionId} → ${session.surrealSessionId}`);
        }
        catch (e) {
            swallow("userPromptSubmit:ensureSessionRow", e);
        }
    }
    // Increment session turn_count at turn START (0.7.12+). Previously this
    // was done in Stop, which is the most fragile lifecycle hook (timeouts,
    // transcript-read failures, occasional drops). UserPromptSubmit is
    // reliable: fires synchronously when the user types, never dropped,
    // no transcript dependency. Token accounting still happens in Stop
    // because token counts aren't known until the assistant has responded.
    // Fire-and-forget so the hook returns promptly.
    if (state.store.isAvailable() && session.surrealSessionId) {
        state.store.bumpSessionTurn(session.surrealSessionId)
            .catch(e => swallow("userPromptSubmit:bumpTurn", e));
    }
    // Claude Code sends the user's text in `prompt`. Earlier code read
    // `payload.user_prompt`, which never existed in the actual hook payload —
    // the handler silently early-returned on every prompt for ~20 days,
    // killing turn ingestion and the entire retrieval pipeline.
    const userPrompt = payload.prompt ?? payload.user_prompt ?? "";
    if (!userPrompt)
        return {};
    session.lastUserText = userPrompt;
    // Ingest user message into graph (async, don't block context assembly)
    ingestTurn(state, session, "user", userPrompt).catch(() => { });
    // Run full context retrieval pipeline
    const contextString = await assembleContextString(state, session, userPrompt);
    // On first turn, check for pending background work from previous sessions
    let pendingWorkMessage = "";
    if (session.userTurnCount <= 1 && state.store.isAvailable()) {
        try {
            const pending = await state.store.queryFirst(`SELECT count() AS count FROM pending_work WHERE status = "pending" GROUP ALL`);
            const count = pending[0]?.count ?? 0;
            if (count > 0) {
                pendingWorkMessage = `\n\n<kongcode_pending_work>
KongCode has ${count} pending memory operation${count > 1 ? "s" : ""} from previous sessions (extraction, reflection, skills, soul).

IMPORTANT: Spawn a background agent to process these. Use:
- subagent_type: "kongcode:memory-extractor"
- model: opus (highest intelligence for knowledge extraction)
- run_in_background: true
- Prompt: "Process all pending KongCode memory work. Loop: call fetch_pending_work to get the next item, analyze the data according to the instructions provided, then call commit_work_results with your output. Repeat until fetch_pending_work returns empty. Be thorough in your extractions — this is the intelligence layer."

This runs silently in the background. Respond to the user normally.
</kongcode_pending_work>`;
                log.info(`[pending_work] ${count} items queued for subagent processing`);
            }
        }
        catch (e) {
            swallow("userPromptSubmit:pendingCheck", e);
        }
    }
    // E3: anomaly-only health injection. Runs cheap absolute-threshold
    // detectors and prepends a [kongcode-alert] block ONLY if any flag fires.
    // Cooldowns prevent spam; absent alerts mean substrate is healthy.
    let anomalyBlock = "";
    if (state.store.isAvailable()) {
        try {
            const flags = await detectAnomalies(state.store, state.observabilityCooldown);
            if (flags.length > 0)
                anomalyBlock = formatAnomalyBlock(flags);
        }
        catch (e) {
            swallow("userPromptSubmit:anomalies", e);
        }
    }
    const additionalContext = [anomalyBlock, contextString, pendingWorkMessage].filter(Boolean).join("") || undefined;
    log.debug(`UserPromptSubmit: session=${sessionId}, context=${contextString ? "injected" : "none"}, pending=${pendingWorkMessage ? "yes" : "no"}`);
    return makeHookOutput("UserPromptSubmit", wrapKongcodeContext(additionalContext));
}
