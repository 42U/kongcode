/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */

import { Type } from "@sinclair/typebox";
import type { GlobalPluginState, SessionState } from "../state.js";
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

const COUNT_FILTERS: Record<string, string> = {
  active: "WHERE active = true",
  inactive: "WHERE active = false",
  recent_24h: "WHERE created_at > time::now() - 24h",
  with_embedding: "WHERE embedding != NONE AND array::len(embedding) > 0",
  unresolved: "WHERE status != 'resolved' OR status IS NONE",
};

const QUERY_TEMPLATES: Record<string, { sql: string; description: string; needsTable?: boolean }> = {
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
    sql: `SELECT id, content, created_at, source
          FROM concept
          WHERE created_at < time::now() - 1h
            AND array::len(->derived_from->?) = 0
          ORDER BY created_at DESC
          LIMIT 25`,
    description: "Concepts >1h old with no derived_from provenance edge (silent-failure detector)",
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

export function createIntrospectToolDef(state: GlobalPluginState, session: SessionState) {
  return {
    name: "introspect",
    label: "Memory Introspect",
    description: "Inspect your memory database. Use for ALL database queries — NEVER use curl or bash to access SurrealDB directly. Actions: status (health + table counts), count (filtered row counts), verify (confirm record exists), query (predefined reports).",
    parameters: introspectSchema,
    execute: async (_toolCallId: string, params: {
      action: "status" | "count" | "verify" | "query" | "migrate" | "trends";
      table?: string; filter?: string; record_id?: string;
    }) => {
      const { store } = state;
      if (!store.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Database unavailable." }], details: null };
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
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Introspect failed: ${err}` }], details: null };
      }
    },
  };
}

// ── Actions ──────────────────────────────────────────────────────────────

async function statusAction(store: any, sessionId: string, embeddings: any) {
  const info = store.getInfo();
  const alive = await store.ping();
  const embStatus = await probeEmbeddingService(embeddings);

  const lines: string[] = [];
  lines.push("MEMORY DATABASE STATUS");
  lines.push("═══════════════════════════════════");
  lines.push(`Connection:  ${info?.url ?? "unknown"}`);
  lines.push(`Namespace:   ${info?.ns ?? "unknown"}`);
  lines.push(`Database:    ${info?.db ?? "unknown"}`);
  lines.push(`Ping:        ${alive ? "OK" : "FAILED"}`);
  lines.push(`Embeddings:  ${embStatus.label}`);
  lines.push(`Session:     ${sessionId}`);
  lines.push("");

  const counts: Record<string, number> = {};
  const embCounts: Record<string, number> = {};

  for (const t of ALLOWED_TABLES) {
    try {
      const rows = await store.queryFirst(
        `SELECT count() AS count FROM type::table($t) GROUP ALL`, { t },
      );
      counts[t] = rows[0]?.count ?? 0;
    } catch { counts[t] = -1; }
  }

  for (const t of VECTOR_TABLES) {
    try {
      const rows = await store.queryFirst(
        `SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t },
      );
      embCounts[t] = rows[0]?.count ?? 0;
    } catch { embCounts[t] = 0; }
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
    } else {
      const report = await checkGraduation(store);
      lines.push(formatGraduationReport(report));
    }
  } catch {
    lines.push("Status: Unable to check graduation");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { counts, embCounts, alive, totalNodes, totalEmb, embeddings: embStatus },
  };
}

// Probe the in-process BGE-M3 service. isAvailable() only checks the `ready`
// flag; a real one-token embed proves the runtime path actually works (catches
// native-binding crashes that leave `ready=true` but throw on use). When down,
// pull from getDiagnostics() to name the actual init failure instead of just
// reporting `isAvailable=false`.
async function probeEmbeddingService(embeddings: any): Promise<{ status: "ok" | "down" | "degraded"; label: string }> {
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
    const probe = embeddings.embed("ping").then((v: number[]) => v?.length ?? 0);
    const len = await Promise.race([
      probe,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 1500)),
    ]);
    if (typeof len === "number" && len > 0) {
      return { status: "ok", label: `OK (BGE-M3 responsive, ${len}-dim)` };
    }
    return { status: "degraded", label: "DEGRADED — embed returned empty vector" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "degraded", label: `DEGRADED — embed probe failed: ${msg.slice(0, 100)}` };
  }
}

async function countAction(store: any, table?: string, filter?: string) {
  if (!table || !ALLOWED_TABLES.has(table)) {
    return {
      content: [{ type: "text" as const, text: `Error: valid 'table' required. Available: ${[...ALLOWED_TABLES].sort().join(", ")}` }],
      details: null,
    };
  }

  let whereClause = "";
  if (filter) {
    if (!COUNT_FILTERS[filter]) {
      return {
        content: [{ type: "text" as const, text: `Error: unknown filter "${filter}". Available: ${Object.keys(COUNT_FILTERS).join(", ")}` }],
        details: null,
      };
    }
    whereClause = " " + COUNT_FILTERS[filter];
  }

  const rows = await store.queryFirst(
    `SELECT count() AS count FROM type::table($t)${whereClause} GROUP ALL`, { t: table },
  );
  const count = rows[0]?.count ?? 0;
  return {
    content: [{ type: "text" as const, text: `${table}: ${count} rows${filter ? ` (filter: ${filter})` : ""}` }],
    details: { table, count, filter },
  };
}

async function verifyAction(store: any, recordId?: string) {
  if (!recordId) {
    return { content: [{ type: "text" as const, text: "Error: 'record_id' is required." }], details: null };
  }
  try { assertRecordId(recordId); } catch {
    return { content: [{ type: "text" as const, text: `Error: invalid record ID "${recordId}".` }], details: null };
  }

  // Direct interpolation safe: assertRecordId validates format above
  const rows = await store.queryFirst(`SELECT * FROM ${recordId}`);
  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `Record not found: ${recordId}` }], details: { exists: false } };
  }

  const record = rows[0];
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record as Record<string, unknown>)) {
    if (Array.isArray(val) && val.length > 100 && typeof val[0] === "number") {
      cleaned[key] = `[${val.length} dims]`;
    } else {
      cleaned[key] = val;
    }
  }

  const lines = Object.entries(cleaned)
    .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v.slice(0, 300) : JSON.stringify(v)}`)
    .join("\n");

  return {
    content: [{ type: "text" as const, text: `Record ${recordId}:\n${lines}` }],
    details: { exists: true, id: recordId, record: cleaned },
  };
}

async function migrateAction(state: GlobalPluginState, filter?: string) {
  if (filter === "backfill_derived_from") {
    return await backfillDerivedFromAction(state);
  }
  if (filter === "backfill_project_id") {
    return await backfillProjectIdAction(state);
  }
  const { store, embeddings, workspaceDir } = state;
  if (!workspaceDir) {
    return {
      content: [{ type: "text" as const, text: "No workspace directory configured — cannot migrate." }],
      details: null,
    };
  }

  const result = await migrateWorkspace(workspaceDir, store, embeddings);

  const lines: string[] = [];
  lines.push("WORKSPACE MIGRATION REPORT");
  lines.push("═══════════════════════════════════");
  lines.push(`Files ingested:  ${result.ingested}`);
  lines.push(`Files skipped:   ${result.skipped}`);
  lines.push(`Archived:        ${result.archived ? "Yes" : "No"}`);
  if (result.archivePath) lines.push(`Archive path:    ${result.archivePath}`);
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
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: result,
  };
}

// Repairs concepts orphaned by the pre-0.7.23 derived_from schema mismatch.
// The old schema declared IN concept OUT task while create_knowledge_gems
// writes concept→artifact, so RELATE failed silently and concepts stayed as
// islands. We re-RELATE by matching concept.source = "gem:<X>" to
// artifact.path = "<X>" — the contract create_knowledge_gems uses at write
// time. Idempotent: skips concepts that already have a derived_from edge.
async function backfillDerivedFromAction(state: GlobalPluginState) {
  const { store } = state;
  const orphans = await store.queryFirst<{ id: string; source: string }>(
    `SELECT id, source FROM concept
     WHERE source IS NOT NONE
       AND string::starts_with(source, 'gem:')
       AND array::len(->derived_from->?) = 0`,
  );

  let fixed = 0;
  let missingArtifact = 0;
  let relateFailed = 0;
  const unmatched: string[] = [];

  for (const o of orphans) {
    const path = String(o.source).slice(4); // strip "gem:"
    const artifacts = await store.queryFirst<{ id: string }>(
      `SELECT id FROM artifact WHERE path = $path LIMIT 1`,
      { path },
    );
    if (artifacts.length === 0) {
      missingArtifact++;
      if (unmatched.length < 5) unmatched.push(path);
      continue;
    }
    try {
      await store.relate(String(o.id), "derived_from", String(artifacts[0].id));
      fixed++;
    } catch {
      relateFailed++;
    }
  }

  const lines: string[] = [];
  lines.push("BACKFILL derived_from");
  lines.push("═══════════════════════════════════");
  lines.push(`Orphan concepts found:    ${orphans.length}`);
  lines.push(`Edges created:            ${fixed}`);
  lines.push(`Missing source artifact:  ${missingArtifact}`);
  lines.push(`RELATE failed:            ${relateFailed}`);
  if (unmatched.length > 0) {
    lines.push("");
    lines.push("Sample unmatched source paths:");
    for (const p of unmatched) lines.push(`  - ${p}`);
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { orphans: orphans.length, fixed, missingArtifact, relateFailed },
  };
}

// 0.7.26: backfill `project_id` field on concepts and memories created before
// project-scoped retrieval landed. Concepts: derive from existing
// ->relevant_to->project edge. Memories: derive from session.project_id of
// the originating session (memory.session_id → session.project_id).
// Idempotent — only updates rows where project_id IS NONE.
async function backfillProjectIdAction(state: GlobalPluginState) {
  const { store } = state;

  // Concepts: id, project_id from outgoing relevant_to edge
  const conceptRows = await store.queryFirst<{ id: string; project_id: string }>(
    `SELECT id, ->relevant_to->project[0].id AS project_id
     FROM concept
     WHERE project_id IS NONE
       AND ->relevant_to->project[0] IS NOT NONE`,
  );
  let conceptsFixed = 0;
  for (const row of conceptRows) {
    if (!row.project_id) continue;
    try {
      await store.queryExec(
        `UPDATE ${row.id} SET project_id = $pid`,
        { pid: row.project_id },
      );
      conceptsFixed++;
    } catch { /* skip */ }
  }

  // Memories: id, project_id from session.project_id
  const memoryRows = await store.queryFirst<{ id: string; project_id: string }>(
    `SELECT id, (SELECT project_id FROM session WHERE id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM memory
     WHERE project_id IS NONE AND session_id IS NOT NONE`,
  );
  let memoriesFixed = 0;
  for (const row of memoryRows) {
    if (!row.project_id) continue;
    try {
      await store.queryExec(
        `UPDATE ${row.id} SET project_id = $pid`,
        { pid: row.project_id },
      );
      memoriesFixed++;
    } catch { /* skip */ }
  }

  const lines: string[] = [];
  lines.push("BACKFILL project_id");
  lines.push("═══════════════════════════════════");
  lines.push(`Concept rows backfilled:  ${conceptsFixed} / ${conceptRows.length}`);
  lines.push(`Memory rows backfilled:   ${memoriesFixed} / ${memoryRows.length}`);
  lines.push("");
  lines.push("Re-runnable: only updates rows where project_id IS NONE.");
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      concepts: { found: conceptRows.length, fixed: conceptsFixed },
      memories: { found: memoryRows.length, fixed: memoriesFixed },
    },
  };
}

async function trendsAction(state: GlobalPluginState) {
  const trends = await computeTrends(state.store, 7);
  const lines: string[] = [];
  lines.push(`SUBSTRATE TRENDS — last ${trends.window_days} days`);
  lines.push("═══════════════════════════════════");
  if (trends.rollups.length === 0) {
    lines.push("No daily rollups yet. The maintenance pass writes one row per day at the");
    lines.push("first turn after midnight UTC. Check back tomorrow, or wait for substrate");
    lines.push("activity to accumulate (orchestrator_metrics_daily is keyed on YYYY-MM-DD).");
    return { content: [{ type: "text" as const, text: lines.join("\n") }], details: trends };
  }
  lines.push("");
  lines.push("Daily rollups:");
  lines.push("  day         | turns | tools | dur(ms) | tok_in  | tok_out | retr_util | tool_fail | fast%");
  for (const r of trends.rollups) {
    lines.push(
      `  ${r.day}  | ${pad(r.turn_count, 5)} | ${pad(r.mean_tool_calls.toFixed(1), 5)} | `
      + `${pad(r.mean_turn_duration_ms.toFixed(0), 7)} | ${pad(r.mean_tokens_in.toFixed(0), 7)} | `
      + `${pad(r.mean_tokens_out.toFixed(0), 7)} | ${pad((r.mean_retrieval_util * 100).toFixed(1) + "%", 9)} | `
      + `${pad((r.tool_failure_rate * 100).toFixed(1) + "%", 9)} | ${(r.fast_path_rate * 100).toFixed(0)}%`,
    );
  }
  lines.push("");
  lines.push("Window summary:");
  lines.push(`  avg turns/day:       ${trends.summary.avg_turns_per_day.toFixed(1)}`);
  lines.push(`  avg tool calls:      ${trends.summary.avg_tool_calls.toFixed(2)}`);
  lines.push(`  avg retrieval util:  ${(trends.summary.avg_retrieval_util * 100).toFixed(1)}%`);
  lines.push(`  avg tokens in:       ${trends.summary.avg_tokens_in.toFixed(0)}`);
  lines.push(`  avg tokens out:      ${trends.summary.avg_tokens_out.toFixed(0)}`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: trends };
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w, " ");
}

async function queryAction(store: any, table?: string, template?: string) {
  const tmpl = template ?? "";
  if (!QUERY_TEMPLATES[tmpl]) {
    const available = Object.entries(QUERY_TEMPLATES)
      .map(([k, v]) => `  ${k}${v.needsTable ? " (requires table)" : ""}: ${v.description}`)
      .join("\n");
    return {
      content: [{ type: "text" as const, text: `Available query templates:\n${available}` }],
      details: { templates: Object.keys(QUERY_TEMPLATES) },
    };
  }

  const spec = QUERY_TEMPLATES[tmpl];
  if (spec.needsTable && (!table || !ALLOWED_TABLES.has(table))) {
    return {
      content: [{ type: "text" as const, text: `Error: "${tmpl}" requires a valid table.` }],
      details: null,
    };
  }

  // Embedding coverage special case
  if (tmpl === "embedding_coverage") {
    const lines: string[] = [];
    for (const t of VECTOR_TABLES) {
      try {
        const totalRows = await store.queryFirst(
          `SELECT count() AS count FROM type::table($t) GROUP ALL`, { t },
        );
        const embRows = await store.queryFirst(
          `SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t },
        );
        const total = totalRows[0]?.count ?? 0;
        const emb = embRows[0]?.count ?? 0;
        const pct = total > 0 ? Math.round((emb / total) * 100) : 0;
        lines.push(`  ${(t + ":").padEnd(20)} ${emb}/${total} (${pct}%)`);
      } catch { /* skip */ }
    }
    return { content: [{ type: "text" as const, text: `Embedding coverage:\n${lines.join("\n")}` }], details: null };
  }

  // Only pass `t` to queries that actually use it (needsTable). Avoids
  // misleading "(pending_work)" label when the SQL is hardcoded against a
  // different table.
  const rows = await store.queryFirst(spec.sql, spec.needsTable && table ? { t: table } : undefined);
  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: `No results for "${tmpl}".` }], details: null };
  }

  const formatted = rows.map((r: any, i: number) => {
    const fields = Object.entries(r)
      .filter(([k]) => k !== "embedding")
      .map(([k, v]) => {
        if (typeof v === "string" && v.length > 200) return `${k}: ${v.slice(0, 200)}...`;
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join(", ");
    return `${i + 1}. ${fields}`;
  }).join("\n");

  // Show "(table)" suffix only for templates that actually consume the table param.
  const label = spec.needsTable && table ? `${tmpl} (${table})` : tmpl;
  return {
    content: [{ type: "text" as const, text: `${label}:\n${formatted}` }],
    details: { count: rows.length },
  };
}
