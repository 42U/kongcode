/**
 * SessionEnd hook handler.
 *
 * Queues cognitive work (extraction, reflection, skills, soul) to the
 * pending_work table for processing by a subagent on the next session.
 * No LLM calls — all intelligence runs through Claude subagents.
 */
import { hasSoul, checkStageTransition } from "../engine/soul.js";
import { writeHandoffFileSync } from "../engine/handoff-file.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
export async function handleSessionEnd(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId);
    if (!session || session.cleanedUp)
        return {};
    log.info(`Session end: ${sessionId}`);
    const { store } = state;
    session.cleanedUp = true;
    if (!store.isAvailable())
        return {};
    // Queue cognitive work for subagent processing on next session
    const queueOps = [];
    // Extraction — always queue if session had meaningful conversation
    if (session.userTurnCount >= 2) {
        queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
            data: {
                work_type: "extraction",
                session_id: session.sessionId,
                surreal_session_id: session.surrealSessionId,
                task_id: session.taskId,
                project_id: session.projectId,
                payload: { turn_count: session.userTurnCount },
                priority: 1,
            },
        }).catch(e => swallow("sessionEnd:queueExtraction", e)));
    }
    // Handoff note — high priority, needed for next wakeup
    if (session.userTurnCount >= 2) {
        queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
            data: {
                work_type: "handoff_note",
                session_id: session.sessionId,
                surreal_session_id: session.surrealSessionId,
                priority: 2,
            },
        }).catch(e => swallow("sessionEnd:queueHandoff", e)));
    }
    // Reflection — needs 3+ turns for meaningful analysis
    if (session.userTurnCount >= 3) {
        queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
            data: {
                work_type: "reflection",
                session_id: session.sessionId,
                surreal_session_id: session.surrealSessionId,
                priority: 3,
            },
        }).catch(e => swallow("sessionEnd:queueReflection", e)));
    }
    // Skill extraction — needs 4+ turns for meaningful patterns
    if (session.userTurnCount >= 4) {
        queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
            data: {
                work_type: "skill_extract",
                session_id: session.sessionId,
                task_id: session.taskId,
                priority: 5,
            },
        }).catch(e => swallow("sessionEnd:queueSkill", e)));
    }
    // Causal chain graduation
    queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
            work_type: "causal_graduate",
            session_id: session.sessionId,
            priority: 7,
        },
    }).catch(e => swallow("sessionEnd:queueCausal", e)));
    // Soul graduation or evolution
    const soulExists = await hasSoul(store).catch(() => false);
    queueOps.push(store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
            work_type: soulExists ? "soul_evolve" : "soul_generate",
            session_id: session.sessionId,
            priority: 9,
        },
    }).catch(e => swallow("sessionEnd:queueSoul", e)));
    await Promise.allSettled(queueOps);
    // Stage transition check (no LLM needed — reads DB directly)
    try {
        const transition = await checkStageTransition(store);
        if (transition.transitioned) {
            log.info(`[MATURITY] ${transition.previousStage ?? "nascent"} → ${transition.currentStage}`);
        }
    }
    catch (e) {
        swallow("sessionEnd:stageTransition", e);
    }
    // Mark session ended in DB
    try {
        await store.endSession(session.surrealSessionId);
    }
    catch (e) {
        swallow.warn("sessionEnd:endSession", e);
    }
    // Write handoff file (sync, for crash safety)
    try {
        writeHandoffFileSync({
            sessionId: session.sessionId,
            timestamp: new Date().toISOString(),
            userTurnCount: session.userTurnCount,
            lastUserText: session.lastUserText.slice(0, 500),
            lastAssistantText: session.lastAssistantText.slice(0, 500),
            unextractedTokens: 0,
        }, state.workspaceDir ?? process.cwd());
    }
    catch (e) {
        swallow.warn("sessionEnd:handoff", e);
    }
    // Cleanup session from state
    state.removeSession(sessionId);
    return {};
}
