/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */

import { Type } from "@sinclair/typebox";
import type { GlobalPluginState, SessionState } from "../state.js";
import { assertRecordId } from "../surreal.js";
import { migrateWorkspace } from "../workspace-migrate.js";
import { checkGraduation, formatGraduationReport, hasSoul } from "../soul.js";

const ALLOWED_TABLES = new Set([
  "agent", "project", "task", "artifact", "concept",
  "turn", "identity_chunk", "session", "memory",
  "core_memory", "monologue", "skill", "reflection",
  "retrieval_outcome", "orchestrator_metrics",
  "causal_chain", "compaction_checkpoint", "subagent",
  "memory_utility_cache", "soul", "graduation_event", "maturity_stage",
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
    description: "Core memory entries grouped by category",
  },
  memory_status: {
    sql: "SELECT status, count() AS count FROM memory GROUP BY status",
    description: "Memory counts grouped by status",
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
  ], { description: "Action: status (health overview), count (row counts), verify (confirm record), query (predefined reports), migrate (ingest workspace .md files into DB — ask user first)." }),
  table: Type.Optional(Type.String({ description: "Table name for count/query actions." })),
  filter: Type.Optional(Type.String({ description: "For count: active, inactive, recent_24h, with_embedding, unresolved. For query: template name." })),
  record_id: Type.Optional(Type.String({ description: "Record ID for verify action (e.g. memory:abc123)." })),
});

export function createIntrospectToolDef(state: GlobalPluginState, session: SessionState) {
  return {
    name: "introspect",
    label: "Memory Introspect",
    description: "Inspect your memory database. Use for ALL database queries — NEVER use curl or bash to access SurrealDB directly. Actions: status (health + table counts), count (filtered row counts), verify (confirm record exists), query (predefined reports).",
    parameters: introspectSchema,
    execute: async (_toolCallId: string, params: {
      action: "status" | "count" | "verify" | "query" | "migrate";
      table?: string; filter?: string; record_id?: string;
    }) => {
      const { store } = state;
      if (!store.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Database unavailable." }], details: null };
      }

      try {
        switch (params.action) {
          case "status": return await statusAction(store, session.sessionId);
          case "count": return await countAction(store, params.table, params.filter);
          case "verify": return await verifyAction(store, params.record_id);
          case "query": return await queryAction(store, params.table, params.filter);
          case "migrate": return await migrateAction(state);
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Introspect failed: ${err}` }], details: null };
      }
    },
  };
}

// ── Actions ──────────────────────────────────────────────────────────────

async function statusAction(store: any, sessionId: string) {
  const info = store.getInfo();
  const alive = await store.ping();

  const lines: string[] = [];
  lines.push("MEMORY DATABASE STATUS");
  lines.push("═══════════════════════════════════");
  lines.push(`Connection:  ${info?.url ?? "unknown"}`);
  lines.push(`Namespace:   ${info?.ns ?? "unknown"}`);
  lines.push(`Database:    ${info?.db ?? "unknown"}`);
  lines.push(`Ping:        ${alive ? "OK" : "FAILED"}`);
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
    details: { counts, embCounts, alive, totalNodes, totalEmb },
  };
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

async function migrateAction(state: GlobalPluginState) {
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

  const rows = await store.queryFirst(spec.sql, table ? { t: table } : undefined);
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

  return {
    content: [{ type: "text" as const, text: `${tmpl}${table ? ` (${table})` : ""}:\n${formatted}` }],
    details: { count: rows.length },
  };
}
