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
};
const introspectSchema = Type.Object({
    action: Type.Union([
        Type.Literal("status"),
        Type.Literal("count"),
        Type.Literal("verify"),
        Type.Literal("query"),
        Type.Literal("migrate"),
        Type.Literal("trends"),
    ], { description: "Action: status (health overview), count (row counts), verify (confirm record), query (predefined reports), migrate (ingest workspace .md files into DB — ask user first), trends (daily rolling means + anomaly flags from orchestrator_metrics_daily)." }),
    table: Type.Optional(Type.String({ description: "Table name for count/query actions." })),
    filter: Type.Optional(Type.String({ description: "For count: active, inactive, recent_24h, with_embedding, unresolved. For query: template name." })),
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
                    case "migrate": return await migrateAction(state);
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
async function migrateAction(state) {
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
