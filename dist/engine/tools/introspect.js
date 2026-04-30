/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */
import { Type } from "@sinclair/typebox";
import { assertRecordId } from "../surreal.js";
import { migrateWorkspace } from "../workspace-migrate.js";
import { checkGraduation, formatGraduationReport, hasSoul } from "../soul.js";
import { computeTrends } from "../observability.js";
const ALLOWED_TABLES = new Set([
    "agent", "project", "task", "artifact", "concept",
    "turn", "identity_chunk", "session", "memory",
    "core_memory", "monologue", "skill", "reflection",
    "retrieval_outcome", "orchestrator_metrics",
    "causal_chain", "compaction_checkpoint", "subagent",
    "memory_utility_cache", "soul", "graduation_event", "maturity_stage", "pending_work",
]);
const VECTOR_TABLES = new Set([
    "concept", "memory", "artifact", "identity_chunk", "turn", "monologue", "skill", "reflection",
]);
const COUNT_FILTERS = {
    active: "WHERE active = true",
    inactive: "WHERE active = false",
    recent_24h: "WHERE created_at > time::now() - 24h",
    with_embedding: "WHERE embedding != NONE AND array::len(embedding) > 0",
    unresolved: "WHERE status != 'resolved' OR status IS NONE",
};
const QUERY_TEMPLATES = {
    recent: {
        sql: "SELECT id, text, content, description, created_at FROM type::table($t) ORDER BY created_at DESC LIMIT 5",
        description: "Last 5 records by creation time",
        needsTable: true,
    },
    sessions: {
        sql: "SELECT id, started_at, turn_count, total_input_tokens, total_output_tokens, last_active FROM session ORDER BY started_at DESC LIMIT 10",
        description: "Last 10 sessions with stats",
    },
    core_by_category: {
        sql: "SELECT category, count() AS count FROM core_memory WHERE active = true GROUP BY category",
        description: "Core memory entries grouped by category (always queries core_memory table; ignores table param)",
    },
    memory_status: {
        sql: "SELECT status, count() AS count FROM memory GROUP BY status",
        description: "Memory counts grouped by status (always queries memory table; ignores table param)",
    },
    status_breakdown: {
        sql: "SELECT status, count() AS count FROM type::table($t) GROUP BY status",
        description: "Generic status breakdown for any status-bearing table — pass table=<name>",
        needsTable: true,
    },
    pending_work_summary: {
        sql: "SELECT work_type, status, count() AS count FROM pending_work GROUP BY work_type, status ORDER BY work_type, status",
        description: "pending_work queue: row counts grouped by work_type AND status",
    },
    embedding_coverage: {
        sql: "",
        description: "Per-table embedding vs total counts",
    },
    orphan_concepts: {
        // Concepts older than 1h with no derived_from edge — flags provenance
        // gaps from the kind of silent edge-write failure that 0.7.23 fixed.
        // 0.7.33: exclude `ingest:turn` source. Per-turn extractions don't write
        // `derived_from` edges (the turn IS their provenance, traversable via
        // the existing `mentions` edge from turn→concept). They were dominating
        // the result set with hundreds of false-positive "orphans" per active
        // session. The detector should fire only for missing-edge bugs in
        // gem/causal extraction, where derived_from is the canonical link.
        sql: `SELECT id, content, created_at, source
          FROM concept
          WHERE created_at < time::now() - 1h
            AND array::len(->derived_from->?) = 0
            AND (source IS NONE OR source != 'ingest:turn')
          ORDER BY created_at DESC
          LIMIT 25`,
        description: "Concepts >1h old with no derived_from provenance edge (excludes ingest:turn — those use the turn->concept mentions edge instead)",
    },
};
const introspectSchema = Type.Object({
    action: Type.Union([
        Type.Literal("status"),
        Type.Literal("count"),
        Type.Literal("verify"),
        Type.Literal("query"),
        Type.Literal("migrate"),
        Type.Literal("trends"),
    ], { description: "Action: status (health overview), count (row counts), verify (confirm record), query (predefined reports), migrate (default: ingest workspace .md files; filter=backfill_derived_from for pre-0.7.23 orphan provenance, filter=backfill_project_id for pre-0.7.26 unscoped concepts/memories — ask user first), trends (daily rolling means + anomaly flags from orchestrator_metrics_daily)." }),
    table: Type.Optional(Type.String({ description: "Table name for count/query actions." })),
    filter: Type.Optional(Type.String({ description: "For count: active, inactive, recent_24h, with_embedding, unresolved. For query: template name. For migrate: backfill_derived_from (pre-0.7.23 orphan edges) or backfill_project_id (pre-0.7.26 missing project scope on concepts/memories)." })),
    record_id: Type.Optional(Type.String({ description: "Record ID for verify action (e.g. memory:abc123)." })),
});
export function createIntrospectToolDef(state, session) {
    return {
        name: "introspect",
        label: "Memory Introspect",
        description: "Inspect your memory database. Use for ALL database queries — NEVER use curl or bash to access SurrealDB directly. Actions: status (health + table counts), count (filtered row counts), verify (confirm record exists), query (predefined reports).",
        parameters: introspectSchema,
        execute: async (_toolCallId, params) => {
            const { store } = state;
            if (!store.isAvailable()) {
                return { content: [{ type: "text", text: "Database unavailable." }], details: null };
            }
            try {
                switch (params.action) {
                    case "status": return await statusAction(store, session.sessionId, state.embeddings);
                    case "count": return await countAction(store, params.table, params.filter);
                    case "verify": return await verifyAction(store, params.record_id);
                    case "query": return await queryAction(store, params.table, params.filter);
                    case "migrate": return await migrateAction(state, params.filter);
                    case "trends": return await trendsAction(state);
                }
            }
            catch (err) {
                return { content: [{ type: "text", text: `Introspect failed: ${err}` }], details: null };
            }
        },
    };
}
// ── Actions ──────────────────────────────────────────────────────────────
async function statusAction(store, sessionId, embeddings) {
    const info = store.getInfo();
    const alive = await store.ping();
    const embStatus = await probeEmbeddingService(embeddings);
    const lines = [];
    lines.push("MEMORY DATABASE STATUS");
    lines.push("═══════════════════════════════════");
    lines.push(`Connection:  ${info?.url ?? "unknown"}`);
    lines.push(`Namespace:   ${info?.ns ?? "unknown"}`);
    lines.push(`Database:    ${info?.db ?? "unknown"}`);
    lines.push(`Ping:        ${alive ? "OK" : "FAILED"}`);
    lines.push(`Embeddings:  ${embStatus.label}`);
    lines.push(`Session:     ${sessionId}`);
    lines.push("");
    const counts = {};
    const embCounts = {};
    for (const t of ALLOWED_TABLES) {
        try {
            const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) GROUP ALL`, { t });
            counts[t] = rows[0]?.count ?? 0;
        }
        catch {
            counts[t] = -1;
        }
    }
    for (const t of VECTOR_TABLES) {
        try {
            const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t });
            embCounts[t] = rows[0]?.count ?? 0;
        }
        catch {
            embCounts[t] = 0;
        }
    }
    for (const t of ALLOWED_TABLES) {
        const c = counts[t];
        const label = (t + ":").padEnd(28);
        const countStr = c === -1 ? "error" : String(c).padStart(5);
        const embStr = VECTOR_TABLES.has(t) ? `  (${embCounts[t] ?? 0} embedded)` : "";
        lines.push(`  ${label}${countStr}${embStr}`);
    }
    const totalNodes = Object.values(counts).filter(c => c >= 0).reduce((a, b) => a + b, 0);
    const totalEmb = Object.values(embCounts).reduce((a, b) => a + b, 0);
    lines.push("");
    lines.push(`Total records:     ${totalNodes}`);
    lines.push(`Total embeddings:  ${totalEmb}`);
    // Graduation status
    lines.push("");
    lines.push("SOUL GRADUATION");
    lines.push("═══════════════════════════════════");
    try {
        const soulExists = await hasSoul(store);
        if (soulExists) {
            lines.push("Status: GRADUATED (soul document exists)");
        }
        else {
            const report = await checkGraduation(store);
            lines.push(formatGraduationReport(report));
        }
    }
    catch {
        lines.push("Status: Unable to check graduation");
    }
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { counts, embCounts, alive, totalNodes, totalEmb, embeddings: embStatus },
    };
}
// Probe the in-process BGE-M3 service. isAvailable() only checks the `ready`
// flag; a real one-token embed proves the runtime path actually works (catches
// native-binding crashes that leave `ready=true` but throw on use). When down,
// pull from getDiagnostics() to name the actual init failure instead of just
// reporting `isAvailable=false`.
async function probeEmbeddingService(embeddings) {
    if (!embeddings || typeof embeddings.isAvailable !== "function") {
        return { status: "down", label: "DOWN — embedding service not present" };
    }
    if (!embeddings.isAvailable()) {
        const diag = typeof embeddings.getDiagnostics === "function" ? embeddings.getDiagnostics() : null;
        if (diag?.initError) {
            const msg = String(diag.initError.message ?? "").split("\n")[0].slice(0, 200);
            return { status: "down", label: `DOWN — initialize() threw: ${msg}` };
        }
        if (diag?.initStartedAt != null && diag.initFinishedAt == null) {
            const ageS = Math.floor((Date.now() - diag.initStartedAt) / 1000);
            return { status: "down", label: `DOWN — initialize() in progress (${ageS}s elapsed; native build may be running)` };
        }
        if (diag?.initStartedAt == null) {
            return { status: "down", label: "DOWN — initialize() never called (boot path may have skipped embedding init)" };
        }
        return { status: "down", label: "DOWN — isAvailable=false (no diagnostics captured)" };
    }
    try {
        const probe = embeddings.embed("ping").then((v) => v?.length ?? 0);
        const len = await Promise.race([
            probe,
            new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 1500)),
        ]);
        if (typeof len === "number" && len > 0) {
            return { status: "ok", label: `OK (BGE-M3 responsive, ${len}-dim)` };
        }
        return { status: "degraded", label: "DEGRADED — embed returned empty vector" };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "degraded", label: `DEGRADED — embed probe failed: ${msg.slice(0, 100)}` };
    }
}
async function countAction(store, table, filter) {
    if (!table || !ALLOWED_TABLES.has(table)) {
        return {
            content: [{ type: "text", text: `Error: valid 'table' required. Available: ${[...ALLOWED_TABLES].sort().join(", ")}` }],
            details: null,
        };
    }
    let whereClause = "";
    if (filter) {
        if (!COUNT_FILTERS[filter]) {
            return {
                content: [{ type: "text", text: `Error: unknown filter "${filter}". Available: ${Object.keys(COUNT_FILTERS).join(", ")}` }],
                details: null,
            };
        }
        whereClause = " " + COUNT_FILTERS[filter];
    }
    const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t)${whereClause} GROUP ALL`, { t: table });
    const count = rows[0]?.count ?? 0;
    return {
        content: [{ type: "text", text: `${table}: ${count} rows${filter ? ` (filter: ${filter})` : ""}` }],
        details: { table, count, filter },
    };
}
async function verifyAction(store, recordId) {
    if (!recordId) {
        return { content: [{ type: "text", text: "Error: 'record_id' is required." }], details: null };
    }
    try {
        assertRecordId(recordId);
    }
    catch {
        return { content: [{ type: "text", text: `Error: invalid record ID "${recordId}".` }], details: null };
    }
    // Direct interpolation safe: assertRecordId validates format above
    const rows = await store.queryFirst(`SELECT * FROM ${recordId}`);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `Record not found: ${recordId}` }], details: { exists: false } };
    }
    const record = rows[0];
    const cleaned = {};
    for (const [key, val] of Object.entries(record)) {
        if (Array.isArray(val) && val.length > 100 && typeof val[0] === "number") {
            cleaned[key] = `[${val.length} dims]`;
        }
        else {
            cleaned[key] = val;
        }
    }
    const lines = Object.entries(cleaned)
        .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v.slice(0, 300) : JSON.stringify(v)}`)
        .join("\n");
    return {
        content: [{ type: "text", text: `Record ${recordId}:\n${lines}` }],
        details: { exists: true, id: recordId, record: cleaned },
    };
}
async function migrateAction(state, filter) {
    if (filter === "backfill_derived_from") {
        return await backfillDerivedFromAction(state);
    }
    if (filter === "backfill_project_id") {
        return await backfillProjectIdAction(state);
    }
    const { store, embeddings, workspaceDir } = state;
    if (!workspaceDir) {
        return {
            content: [{ type: "text", text: "No workspace directory configured — cannot migrate." }],
            details: null,
        };
    }
    const result = await migrateWorkspace(workspaceDir, store, embeddings);
    const lines = [];
    lines.push("WORKSPACE MIGRATION REPORT");
    lines.push("═══════════════════════════════════");
    lines.push(`Files ingested:  ${result.ingested}`);
    lines.push(`Files skipped:   ${result.skipped}`);
    lines.push(`Archived:        ${result.archived ? "Yes" : "No"}`);
    if (result.archivePath)
        lines.push(`Archive path:    ${result.archivePath}`);
    lines.push("");
    lines.push("Details:");
    for (const detail of result.details) {
        lines.push(`  ${detail}`);
    }
    if (result.ingested > 0) {
        lines.push("");
        lines.push("SOUL.md was left in place — it will be read as a nudge during soul graduation.");
    }
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
    };
}
// Repairs concepts orphaned by the pre-0.7.23 derived_from schema mismatch.
// The old schema declared IN concept OUT task while create_knowledge_gems
// writes concept→artifact, so RELATE failed silently and concepts stayed as
// islands. We re-RELATE by matching concept.source = "gem:<X>" to
// artifact.path = "<X>" — the contract create_knowledge_gems uses at write
// time. Idempotent: skips concepts that already have a derived_from edge.
async function backfillDerivedFromAction(state) {
    const { store } = state;
    const orphans = await store.queryFirst(`SELECT id, source FROM concept
     WHERE source IS NOT NONE
       AND string::starts_with(source, 'gem:')
       AND array::len(->derived_from->?) = 0`);
    let fixed = 0;
    let missingArtifact = 0;
    let relateFailed = 0;
    const unmatched = [];
    for (const o of orphans) {
        const path = String(o.source).slice(4); // strip "gem:"
        const artifacts = await store.queryFirst(`SELECT id FROM artifact WHERE path = $path LIMIT 1`, { path });
        if (artifacts.length === 0) {
            missingArtifact++;
            if (unmatched.length < 5)
                unmatched.push(path);
            continue;
        }
        try {
            await store.relate(String(o.id), "derived_from", String(artifacts[0].id));
            fixed++;
        }
        catch {
            relateFailed++;
        }
    }
    const lines = [];
    lines.push("BACKFILL derived_from");
    lines.push("═══════════════════════════════════");
    lines.push(`Orphan concepts found:    ${orphans.length}`);
    lines.push(`Edges created:            ${fixed}`);
    lines.push(`Missing source artifact:  ${missingArtifact}`);
    lines.push(`RELATE failed:            ${relateFailed}`);
    if (unmatched.length > 0) {
        lines.push("");
        lines.push("Sample unmatched source paths:");
        for (const p of unmatched)
            lines.push(`  - ${p}`);
    }
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { orphans: orphans.length, fixed, missingArtifact, relateFailed },
    };
}
// 0.7.26 + 0.7.29: backfill `project_id` field on rows created before
// project-scoped persistence landed. Order matters — fix sessions first
// (via task→project), then tasks (via project edge), then reflections /
// memories / skills which traverse session_id. Concepts have their own
// edge (relevant_to). Idempotent — only updates rows where project_id
// IS NONE.
async function backfillProjectIdAction(state) {
    const { store } = state;
    async function backfillTable(label, selectSql) {
        const rows = await store.queryFirst(selectSql);
        let fixed = 0;
        for (const row of rows) {
            if (!row.project_id)
                continue;
            try {
                await store.queryExec(`UPDATE ${row.id} SET project_id = $pid`, { pid: row.project_id });
                fixed++;
            }
            catch { /* skip */ }
        }
        return { found: rows.length, fixed };
    }
    // 1. Tasks: traverse ->task_part_of->project (the canonical edge)
    const tasks = await backfillTable("task", `SELECT id, ->task_part_of->project[0].id AS project_id
     FROM task
     WHERE project_id IS NONE
       AND ->task_part_of->project[0] IS NOT NONE`);
    // 2. Sessions: traverse ->session_task->task->task_part_of->project
    //    (must run AFTER tasks so the task.project_id field could be a
    //    fallback path; here we use the edge chain directly).
    const sessions = await backfillTable("session", `SELECT id, ->session_task->task->task_part_of->project[0].id AS project_id
     FROM session
     WHERE project_id IS NONE
       AND ->session_task->task->task_part_of->project[0] IS NOT NONE`);
    // 3. Concepts: outgoing relevant_to edge (already worked in 0.7.26).
    const concepts = await backfillTable("concept", `SELECT id, ->relevant_to->project[0].id AS project_id
     FROM concept
     WHERE project_id IS NONE
       AND ->relevant_to->project[0] IS NOT NONE`);
    // 4. Memories: from the session row's project_id (works now that
    //    sessions have been backfilled in step 2).
    const memories = await backfillTable("memory", 
    // 0.7.30: session_id on memory/reflection/skill rows is the kc_session_id
    // string (e.g. "0df34328-..."), NOT the surreal record ref. Match both
    // shapes so legacy data with either populates correctly.
    `SELECT id, (SELECT project_id FROM session WHERE kc_session_id = $parent.session_id OR id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM memory
     WHERE project_id IS NONE AND session_id IS NOT NONE`);
    // 5. Reflections: same shape as memories (session_id-keyed).
    const reflections = await backfillTable("reflection", 
    // 0.7.30: session_id on memory/reflection/skill rows is the kc_session_id
    // string (e.g. "0df34328-..."), NOT the surreal record ref. Match both
    // shapes so legacy data with either populates correctly.
    `SELECT id, (SELECT project_id FROM session WHERE kc_session_id = $parent.session_id OR id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM reflection
     WHERE project_id IS NONE AND session_id IS NOT NONE`);
    // 6. Skills: traverse ->skill_from_task->task.project_id (after task
    //    backfill). Falls back to session_id-based when no task edge.
    const skillsViaTask = await backfillTable("skill", `SELECT id, ->skill_from_task->task[0].project_id AS project_id
     FROM skill
     WHERE project_id IS NONE
       AND ->skill_from_task->task[0] IS NOT NONE`);
    const skillsViaSession = await backfillTable("skill", 
    // 0.7.30: session_id on memory/reflection/skill rows is the kc_session_id
    // string (e.g. "0df34328-..."), NOT the surreal record ref. Match both
    // shapes so legacy data with either populates correctly.
    `SELECT id, (SELECT project_id FROM session WHERE kc_session_id = $parent.session_id OR id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM skill
     WHERE project_id IS NONE AND session_id IS NOT NONE`);
    // 7. 0.7.35: tag unrecoverable orphans as scope='global'. After all
    //    traversal-based backfills above, any memory/reflection/skill row
    //    still lacking project_id has a session_id that resolves to nothing
    //    (purged session, malformed id). They already surface across projects
    //    via the soft filter (project_id IS NONE) — tagging scope='global'
    //    just makes the implicit-global behavior explicit and zeros out the
    //    "unbackfilled" signal in the report. Retrieval behavior unchanged.
    let globalsTagged = 0;
    for (const table of ["memory", "reflection", "skill"]) {
        try {
            const rows = await store.queryFirst(`SELECT id FROM type::table($t) WHERE project_id IS NONE AND (scope IS NONE OR scope != 'global')`, { t: table });
            for (const row of rows) {
                try {
                    await store.queryExec(`UPDATE ${row.id} SET scope = 'global'`);
                    globalsTagged++;
                }
                catch { /* skip */ }
            }
        }
        catch { /* skip table */ }
    }
    const lines = [];
    lines.push("BACKFILL project_id");
    lines.push("═══════════════════════════════════");
    lines.push(`Task rows backfilled:        ${tasks.fixed} / ${tasks.found}`);
    lines.push(`Session rows backfilled:     ${sessions.fixed} / ${sessions.found}`);
    lines.push(`Concept rows backfilled:     ${concepts.fixed} / ${concepts.found}`);
    lines.push(`Memory rows backfilled:      ${memories.fixed} / ${memories.found}`);
    lines.push(`Reflection rows backfilled:  ${reflections.fixed} / ${reflections.found}`);
    lines.push(`Skill rows backfilled:       ${skillsViaTask.fixed + skillsViaSession.fixed} / ${skillsViaTask.found + skillsViaSession.found}`);
    lines.push(`Unrecoverable → scope=global: ${globalsTagged}`);
    lines.push("");
    lines.push("Re-runnable: only updates rows where project_id IS NONE.");
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
            tasks, sessions, concepts, memories, reflections,
            skills: {
                found: skillsViaTask.found + skillsViaSession.found,
                fixed: skillsViaTask.fixed + skillsViaSession.fixed,
            },
            globalsTagged,
        },
    };
}
async function trendsAction(state) {
    const trends = await computeTrends(state.store, 7);
    const lines = [];
    lines.push(`SUBSTRATE TRENDS — last ${trends.window_days} days`);
    lines.push("═══════════════════════════════════");
    if (trends.rollups.length === 0) {
        lines.push("No daily rollups yet. The maintenance pass writes one row per day at the");
        lines.push("first turn after midnight UTC. Check back tomorrow, or wait for substrate");
        lines.push("activity to accumulate (orchestrator_metrics_daily is keyed on YYYY-MM-DD).");
        return { content: [{ type: "text", text: lines.join("\n") }], details: trends };
    }
    lines.push("");
    lines.push("Daily rollups:");
    lines.push("  day         | turns | tools | dur(ms) | tok_in  | tok_out | retr_util | tool_fail | fast%");
    for (const r of trends.rollups) {
        lines.push(`  ${r.day}  | ${pad(r.turn_count, 5)} | ${pad(r.mean_tool_calls.toFixed(1), 5)} | `
            + `${pad(r.mean_turn_duration_ms.toFixed(0), 7)} | ${pad(r.mean_tokens_in.toFixed(0), 7)} | `
            + `${pad(r.mean_tokens_out.toFixed(0), 7)} | ${pad((r.mean_retrieval_util * 100).toFixed(1) + "%", 9)} | `
            + `${pad((r.tool_failure_rate * 100).toFixed(1) + "%", 9)} | ${(r.fast_path_rate * 100).toFixed(0)}%`);
    }
    lines.push("");
    lines.push("Window summary:");
    lines.push(`  avg turns/day:       ${trends.summary.avg_turns_per_day.toFixed(1)}`);
    lines.push(`  avg tool calls:      ${trends.summary.avg_tool_calls.toFixed(2)}`);
    lines.push(`  avg retrieval util:  ${(trends.summary.avg_retrieval_util * 100).toFixed(1)}%`);
    lines.push(`  avg tokens in:       ${trends.summary.avg_tokens_in.toFixed(0)}`);
    lines.push(`  avg tokens out:      ${trends.summary.avg_tokens_out.toFixed(0)}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: trends };
}
function pad(s, w) {
    return String(s).padStart(w, " ");
}
async function queryAction(store, table, template) {
    const tmpl = template ?? "";
    if (!QUERY_TEMPLATES[tmpl]) {
        const available = Object.entries(QUERY_TEMPLATES)
            .map(([k, v]) => `  ${k}${v.needsTable ? " (requires table)" : ""}: ${v.description}`)
            .join("\n");
        return {
            content: [{ type: "text", text: `Available query templates:\n${available}` }],
            details: { templates: Object.keys(QUERY_TEMPLATES) },
        };
    }
    const spec = QUERY_TEMPLATES[tmpl];
    if (spec.needsTable && (!table || !ALLOWED_TABLES.has(table))) {
        return {
            content: [{ type: "text", text: `Error: "${tmpl}" requires a valid table.` }],
            details: null,
        };
    }
    // Embedding coverage special case
    if (tmpl === "embedding_coverage") {
        const lines = [];
        for (const t of VECTOR_TABLES) {
            try {
                const totalRows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) GROUP ALL`, { t });
                const embRows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t });
                const total = totalRows[0]?.count ?? 0;
                const emb = embRows[0]?.count ?? 0;
                const pct = total > 0 ? Math.round((emb / total) * 100) : 0;
                lines.push(`  ${(t + ":").padEnd(20)} ${emb}/${total} (${pct}%)`);
            }
            catch { /* skip */ }
        }
        return { content: [{ type: "text", text: `Embedding coverage:\n${lines.join("\n")}` }], details: null };
    }
    // Only pass `t` to queries that actually use it (needsTable). Avoids
    // misleading "(pending_work)" label when the SQL is hardcoded against a
    // different table.
    const rows = await store.queryFirst(spec.sql, spec.needsTable && table ? { t: table } : undefined);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `No results for "${tmpl}".` }], details: null };
    }
    const formatted = rows.map((r, i) => {
        const fields = Object.entries(r)
            .filter(([k]) => k !== "embedding")
            .map(([k, v]) => {
            if (typeof v === "string" && v.length > 200)
                return `${k}: ${v.slice(0, 200)}...`;
            return `${k}: ${JSON.stringify(v)}`;
        })
            .join(", ");
        return `${i + 1}. ${fields}`;
    }).join("\n");
    // Show "(table)" suffix only for templates that actually consume the table param.
    const label = spec.needsTable && table ? `${tmpl} (${table})` : tmpl;
    return {
        content: [{ type: "text", text: `${label}:\n${formatted}` }],
        details: { count: rows.length },
    };
}
