import { Surreal } from "surrealdb";
import type { SurrealConfig } from "./config.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";
import { loadSchema } from "./schema-loader.js";

/** Record with a vector similarity score from SurrealDB search */
export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  role?: string;
  timestamp?: string;
  importance?: number;
  accessCount?: number;
  source?: string;
  sessionId?: string;
  table: string;
  embedding?: number[];
}

export interface TurnRecord {
  session_id: string;
  role: string;
  text: string;
  embedding: number[] | null;
  token_count?: number;
  tool_name?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface CoreMemoryEntry {
  id: string;
  text: string;
  category: string;
  priority: number;
  tier: number;
  active: boolean;
  session_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface UtilityCacheEntry {
  avg_utilization: number;
  retrieval_count: number;
}

const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_]+$/;

function assertRecordId(id: string): void {
  if (!RECORD_ID_RE.test(id)) {
    throw new Error(`Invalid record ID format: ${id.slice(0, 40)}`);
  }
}

/** Whitelist of valid SurrealDB edge table names — prevents SQL injection via edge interpolation. */
const VALID_EDGES = new Set([
  // Semantic edges
  "responds_to", "tool_result_of", "summarizes", "mentions", "related_to",
  "narrower", "broader", "about_concept", "reflects_on",
  // Skill edges
  "skill_from_task", "skill_uses_concept",
  // Structural pillar edges
  "owns", "performed", "task_part_of", "session_task",
  "produced", "derived_from", "relevant_to", "used_in", "artifact_mentions",
  // Causal edges
  "caused_by", "supports", "contradicts", "describes",
  // Evolution edges
  "supersedes",
  // Session edges
  "part_of",
]);

function assertValidEdge(edge: string): void {
  if (!VALID_EDGES.has(edge)) throw new Error(`Invalid edge name: ${edge}`);
}

function patchOrderByFields(sql: string): string {
  const s = sql.trim();
  if (!/^\s*SELECT\b/i.test(s) || !/\bORDER\s+BY\b/i.test(s)) return sql;
  if (/^\s*SELECT\s+\*/i.test(s)) return sql;

  const selectMatch = s.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i);
  if (!selectMatch) return sql;
  const selectClause = selectMatch[1];

  const orderMatch = s.match(
    /\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|\s+GROUP\b|\s+HAVING\b|$)/i,
  );
  if (!orderMatch) return sql;

  const orderFields = orderMatch[1]
    .split(",")
    .map((f) => f.trim().replace(/\s+(ASC|DESC)\s*$/i, "").trim())
    .filter(Boolean);

  const selectedFields = selectClause
    .split(",")
    .map((f) => f.trim().split(/\s+AS\s+/i)[0].trim())
    .map((f) => f.split(".").pop()!)
    .filter(Boolean)
    .map((f) => f.toLowerCase());

  const missing = orderFields.filter(
    (f) => !selectedFields.includes(f.split(".").pop()!.toLowerCase()),
  );

  if (missing.length === 0) return sql;

  return sql.replace(
    /(\bSELECT\s+)([\s\S]+?)(\s+FROM\b)/i,
    (_, pre, fields, post) => `${pre}${fields}, ${missing.join(", ")}${post}`,
  );
}

/**
 * SurrealDB store — wraps all database operations for the KongBrain plugin.
 * Replaces the module-level singleton pattern from standalone KongBrain.
 */
export class SurrealStore {
  private db: Surreal;
  private config: SurrealConfig;
  private reconnecting: Promise<void> | null = null;
  private shutdownFlag = false;
  private initialized = false;

  constructor(config: SurrealConfig) {
    this.config = config;
    this.db = new Surreal();
  }

  /** Connect and run schema. Returns true if a new connection was made, false if already initialized. */
  async initialize(): Promise<boolean> {
    // Only connect once — subsequent calls are no-ops.
    // This prevents register()/factory re-invocations from disrupting
    // in-flight operations (deferred cleanup, daemon extraction).
    // Don't check isConnected — ensureConnected() handles reconnection.
    if (this.initialized) return false;
    await this.db.connect(this.config.url, {
      namespace: this.config.ns,
      database: this.config.db,
      authentication: { username: this.config.user, password: this.config.pass },
    });
    await this.runSchema();
    this.initialized = true;
    return true;
  }

  markShutdown(): void {
    this.shutdownFlag = true;
  }

  private async ensureConnected(): Promise<void> {
    if (this.shutdownFlag) return;
    if (this.db.isConnected) return;
    if (this.reconnecting) return this.reconnecting;

    this.reconnecting = (async () => {
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = [500, 1500, 4000];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          log.warn(
            `SurrealDB disconnected — reconnecting (attempt ${attempt}/${MAX_ATTEMPTS})...`,
          );
          this.db = new Surreal();
          const CONNECT_TIMEOUT_MS = 5_000;
          await Promise.race([
            this.db.connect(this.config.url, {
              namespace: this.config.ns,
              database: this.config.db,
              authentication: { username: this.config.user, password: this.config.pass },
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
                CONNECT_TIMEOUT_MS,
              ),
            ),
          ]);
          log.warn("SurrealDB reconnected successfully.");
          return;
        } catch (e) {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          } else {
            log.error(`SurrealDB reconnection failed after ${MAX_ATTEMPTS} attempts.`);
            throw new Error("SurrealDB reconnection failed");
          }
        }
      }
    })().finally(() => {
      this.reconnecting = null;
    });

    return this.reconnecting;
  }

  private async runSchema(): Promise<void> {
    const schema = loadSchema();
    await this.db.query(schema);
  }

  getConnection(): Surreal {
    return this.db;
  }

  isConnected(): boolean {
    return this.db?.isConnected ?? false;
  }

  getInfo(): { url: string; ns: string; db: string; connected: boolean } {
    return {
      url: this.config.url,
      ns: this.config.ns,
      db: this.config.db,
      connected: this.db?.isConnected ?? false,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.db.query("RETURN 'ok'");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.markShutdown();
      await this.db?.close();
    } catch (e) {
      swallow("surreal:close", e);
    }
  }

  /** Returns true if an error is a connection-level failure worth retrying. */
  private isConnectionError(e: unknown): boolean {
    const msg = String((e as { message?: string })?.message ?? e);
    return msg.includes("must be connected") || msg.includes("ConnectionUnavailable");
  }

  /** Run a query function with one retry on connection errors. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!this.isConnectionError(e)) throw e;
      // Connection died — force a fresh connection (close stale socket first)
      this.initialized = false;
      try { await this.db?.close(); } catch { /* ignore */ }
      this.db = new Surreal();
      await this.db.connect(this.config.url, {
        namespace: this.config.ns,
        database: this.config.db,
        authentication: { username: this.config.user, password: this.config.pass },
      });
      return await fn();
    }
  }

  // ── Query helpers ──────────────────────────────────────────────────────

  async queryFirst<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
      const result = await this.db.query<[T[]]>(fullSql, bindings);
      const rows = Array.isArray(result) ? result[result.length - 1] : result;
      return (Array.isArray(rows) ? rows : []).filter(Boolean);
    });
  }

  async queryMulti<T = unknown>(
    sql: string,
    bindings?: Record<string, unknown>,
  ): Promise<T | undefined> {
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
      const raw = await this.db.query(fullSql, bindings);
      const flat = (raw as unknown[]).flat();
      return flat[flat.length - 1] as T | undefined;
    });
  }

  async queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void> {
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
      await this.db.query(fullSql, bindings);
    });
  }

  /**
   * Execute N SQL statements in a single SurrealDB round-trip.
   * Returns one result array per statement; bindings are shared across all statements.
   */
  async queryBatch<T = any>(statements: string[], bindings?: Record<string, unknown>): Promise<T[][]> {
    if (statements.length === 0) return [];
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const joined = statements.map(s => patchOrderByFields(s)).join(";\n");
      const fullSql = `USE NS ${ns} DB ${dbName};\n${joined}`;
      const raw = await this.db.query(fullSql, bindings) as unknown[];
      // First result is the USE statement (empty), skip it
      return raw.slice(1).map(r => (Array.isArray(r) ? r : []).filter(Boolean)) as T[][];
    });
  }

  private async safeQuery(
    sql: string,
    bindings: Record<string, unknown>,
  ): Promise<VectorSearchResult[]> {
    try {
      return await this.queryFirst<VectorSearchResult>(sql, bindings);
    } catch (e) {
      swallow.warn("surreal:safeQuery", e);
      return [];
    }
  }

  // ── Vector search ──────────────────────────────────────────────────────

  /** Multi-table cosine similarity search across turns, concepts, memories, artifacts, monologues, and identity chunks. Returns merged results sorted by score. */
  async vectorSearch(
    vec: number[],
    sessionId: string,
    limits: {
      turn?: number;
      identity?: number;
      concept?: number;
      memory?: number;
      artifact?: number;
      monologue?: number;
    } = {},
    withEmbeddings = false,
  ): Promise<VectorSearchResult[]> {
    const lim = {
      turn: limits.turn ?? 20,
      identity: limits.identity ?? 10,
      concept: limits.concept ?? 15,
      memory: limits.memory ?? 15,
      artifact: limits.artifact ?? 10,
      monologue: limits.monologue ?? 8,
    };
    const sessionTurnLim = Math.ceil(lim.turn / 2);
    const crossTurnLim = lim.turn - sessionTurnLim;
    const emb = withEmbeddings ? ", embedding" : "";

    // Batch all 7 vector searches into a single round-trip (limits inlined — per-table)
    const stmts = [
      `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM turn WHERE embedding != NONE AND array::len(embedding) > 0
         AND session_id = $sid ORDER BY score DESC LIMIT ${sessionTurnLim}`,
      `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM turn WHERE embedding != NONE AND array::len(embedding) > 0
         AND session_id != $sid ORDER BY score DESC LIMIT ${crossTurnLim}`,
      `SELECT id, content AS text, stability AS importance, access_count AS accessCount,
              created_at AS timestamp, 'concept' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM concept WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.concept}`,
      `SELECT id, text, importance, access_count AS accessCount,
              created_at AS timestamp, session_id AS sessionId, 'memory' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM memory WHERE embedding != NONE AND array::len(embedding) > 0
         AND (status = 'active' OR status IS NONE) ORDER BY score DESC LIMIT ${lim.memory}`,
      `SELECT id, description AS text, 0 AS accessCount,
              created_at AS timestamp, 'artifact' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM artifact WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.artifact}`,
      `SELECT id, content AS text, category AS source, 0.5 AS importance, 0 AS accessCount,
              timestamp, 'monologue' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM monologue WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.monologue}`,
      `SELECT id, text, importance, 0 AS accessCount,
              'identity_chunk' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM identity_chunk WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.identity}`,
    ];

    let batchResults: any[][];
    try {
      batchResults = await this.queryBatch<any>(stmts, { vec, sid: sessionId });
    } catch (e) {
      swallow.warn("surreal:vectorSearch:batch", e);
      return [];
    }
    const [sessionTurns = [], crossTurns = [], concepts = [], memories = [], artifacts = [], monologues = [], identityChunks = []] =
      batchResults as VectorSearchResult[][];
    return [
      ...sessionTurns,
      ...crossTurns,
      ...concepts,
      ...memories,
      ...artifacts,
      ...monologues,
      ...identityChunks,
    ];
  }

  // ── Turn operations ────────────────────────────────────────────────────

  async upsertTurn(turn: TurnRecord): Promise<string> {
    const { embedding, ...rest } = turn;
    const record = embedding?.length ? { ...rest, embedding } : rest;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE turn CONTENT $turn RETURN id`,
      { turn: record },
    );
    return String(rows[0]?.id ?? "");
  }

  async getSessionTurns(
    sessionId: string,
    limit = 50,
  ): Promise<{ role: string; text: string }[]> {
    return this.queryFirst<{ role: string; text: string }>(
      `SELECT role, text, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`,
      { sid: sessionId, lim: limit },
    );
  }

  async getSessionTurnsRich(
    sessionId: string,
    limit = 20,
  ): Promise<{ role: string; text: string; tool_name?: string }[]> {
    return this.queryFirst<{ role: string; text: string; tool_name?: string }>(
      `SELECT role, text, tool_name, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`,
      { sid: sessionId, lim: limit },
    );
  }

  // ── Relation helpers ───────────────────────────────────────────────────

  async relate(fromId: string, edge: string, toId: string): Promise<void> {
    assertRecordId(fromId);
    assertRecordId(toId);
    const safeName = edge.replace(/[^a-zA-Z0-9_]/g, "");
    // Direct interpolation safe: assertRecordId validates format above
    await this.queryExec(`RELATE ${fromId}->${safeName}->${toId}`);
  }

  // ── 5-Pillar entity operations ─────────────────────────────────────────

  async ensureAgent(name: string, model?: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `SELECT id FROM agent WHERE name = $name LIMIT 1`,
      { name },
    );
    if (rows.length > 0) return String(rows[0].id);
    const created = await this.queryFirst<{ id: string }>(
      `CREATE agent CONTENT { name: $name, model: $model } RETURN id`,
      { name, ...(model != null ? { model } : {}) },
    );
    return String(created[0]?.id ?? "");
  }

  async ensureProject(name: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `SELECT id FROM project WHERE name = $name LIMIT 1`,
      { name },
    );
    if (rows.length > 0) return String(rows[0].id);
    const created = await this.queryFirst<{ id: string }>(
      `CREATE project CONTENT { name: $name } RETURN id`,
      { name },
    );
    return String(created[0]?.id ?? "");
  }

  async createTask(description: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE task CONTENT { description: $desc, status: "in_progress" } RETURN id`,
      { desc: description },
    );
    return String(rows[0]?.id ?? "");
  }

  async createSession(agentId = "default"): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE session CONTENT { agent_id: $agent_id } RETURN id`,
      { agent_id: agentId },
    );
    return String(rows[0]?.id ?? "");
  }

  async updateSessionStats(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET
        turn_count += 1,
        total_input_tokens += $input,
        total_output_tokens += $output,
        last_active = time::now()`,
      { input: inputTokens, output: outputTokens },
    );
  }

  async endSession(sessionId: string, summary?: string): Promise<void> {
    assertRecordId(sessionId);
    if (summary) {
      await this.queryExec(
        `UPDATE ${sessionId} SET ended_at = time::now(), summary = $summary`,
        { summary },
      );
    } else {
      await this.queryExec(`UPDATE ${sessionId} SET ended_at = time::now()`);
    }
  }

  async markSessionActive(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET cleanup_completed = false, last_active = time::now()`,
    );
  }

  async markSessionEnded(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET ended_at = time::now(), cleanup_completed = true`,
    );
  }

  async getOrphanedSessions(limit = 3): Promise<{ id: string; started_at: string }[]> {
    return this.queryFirst<{ id: string; started_at: string }>(
      `SELECT id, started_at FROM session
       WHERE cleanup_completed != true
         AND started_at < time::now() - 2m
       ORDER BY started_at DESC LIMIT $lim`,
      { lim: limit },
    );
  }

  async linkSessionToTask(sessionId: string, taskId: string): Promise<void> {
    assertRecordId(sessionId);
    assertRecordId(taskId);
    await this.queryExec(
      `RELATE ${sessionId}->session_task->${taskId}`,
    );
  }

  async linkTaskToProject(taskId: string, projectId: string): Promise<void> {
    assertRecordId(taskId);
    assertRecordId(projectId);
    await this.queryExec(
      `RELATE ${taskId}->task_part_of->${projectId}`,
    );
  }

  async linkAgentToTask(agentId: string, taskId: string): Promise<void> {
    assertRecordId(agentId);
    assertRecordId(taskId);
    await this.queryExec(
      `RELATE ${agentId}->performed->${taskId}`,
    );
  }

  async linkAgentToProject(agentId: string, projectId: string): Promise<void> {
    assertRecordId(agentId);
    assertRecordId(projectId);
    await this.queryExec(
      `RELATE ${agentId}->owns->${projectId}`,
    );
  }

  // ── Graph traversal ────────────────────────────────────────────────────

  /**
   * BFS expansion from seed nodes along typed edges, with batched per-hop queries.
   * Each edge query is LIMIT 3 (EDGE_NEIGHBOR_LIMIT) to bound fan-out per node.
   */
  /**
   * Tag-boosted concept retrieval: extract keywords from query text,
   * find concepts tagged with matching terms, score by cosine similarity.
   * Returns concepts that pure vector search might miss due to embedding mismatch.
   */
  async tagBoostedConcepts(
    queryText: string,
    queryVec: number[],
    limit = 10,
  ): Promise<VectorSearchResult[]> {
    // Extract candidate tags from query — lowercase, deduplicate
    const stopwords = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","to","of","in","for","on","with","at","by","from","as","into","about","between","through","during","it","its","this","that","these","those","i","you","we","they","my","your","our","their","what","which","who","how","when","where","why","not","no","and","or","but","if","so","any","all","some","more","just","also","than","very","too","much","many"]);
    const words = queryText.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
    if (words.length === 0) return [];

    // Build tag match condition — match any tag that contains a query word
    const tagConditions = words.slice(0, 8).map(w => `tags CONTAINS '${w.replace(/'/g, "")}'`).join(" OR ");

    try {
      const rows = await this.queryFirst<any>(
        `SELECT id, content AS text, stability AS importance, access_count AS accessCount,
                created_at AS timestamp, 'concept' AS table,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND (${tagConditions})
         ORDER BY score DESC
         LIMIT $limit`,
        { vec: queryVec, limit },
      );
      return rows as VectorSearchResult[];
    } catch (e) {
      swallow.warn("surreal:tagBoostedConcepts", e);
      return [];
    }
  }

  async graphExpand(
    nodeIds: string[],
    queryVec: number[],
    hops = 1,
  ): Promise<VectorSearchResult[]> {
    if (nodeIds.length === 0) return [];

    const MAX_FRONTIER_SEEDS = 5;   // max seed nodes to start BFS from
    const MAX_FRONTIER_PER_HOP = 3; // max nodes carried forward per hop (by score)
    const EDGE_NEIGHBOR_LIMIT = 3;  // max neighbors per edge traversal (inlined in SQL LIMIT)

    const forwardEdges = [
      // Semantic edges
      "responds_to", "tool_result_of", "summarizes",
      "mentions", "related_to", "narrower", "broader",
      "about_concept", "reflects_on", "skill_from_task", "skill_uses_concept",
      // Structural pillar edges (Agent→Project→Task→Artifact→Concept)
      "owns", "performed", "task_part_of", "session_task",
      "produced", "derived_from", "relevant_to", "used_in",
      "artifact_mentions",
    ];
    const reverseEdges = [
      "reflects_on", "skill_from_task",
      // Reverse pillar traversal (find what produced an artifact, what task a concept came from)
      "produced", "derived_from", "performed", "owns",
    ];

    const scoreExpr =
      ", IF embedding != NONE AND array::len(embedding) > 0 THEN vector::similarity::cosine(embedding, $vec) ELSE 0 END AS score";
    const bindings = { vec: queryVec };
    const selectFields = `SELECT id, text, content, description, importance, stability,
                  access_count AS accessCount, created_at AS timestamp,
                  meta::tb(id) AS table${scoreExpr}`;

    const seen = new Set<string>(nodeIds);
    const allNeighbors: VectorSearchResult[] = [];
    let frontier = nodeIds.slice(0, MAX_FRONTIER_SEEDS).filter((id) => RECORD_ID_RE.test(id));

    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      // Batch all edge traversals for this hop in a single round-trip
      const stmts: string[] = [];
      for (const id of frontier) {
        for (const edge of forwardEdges) { assertValidEdge(edge); stmts.push(`${selectFields} FROM ${id}->${edge}->? LIMIT ${EDGE_NEIGHBOR_LIMIT}`); }
        for (const edge of reverseEdges) { assertValidEdge(edge); stmts.push(`${selectFields} FROM ${id}<-${edge}<-? LIMIT ${EDGE_NEIGHBOR_LIMIT}`); }
      }

      let queryResults: any[][];
      try {
        queryResults = await this.queryBatch<any>(stmts, bindings);
      } catch (e) {
        swallow.warn("surreal:graphExpand:batch", e);
        break;
      }
      const nextFrontier: { id: string; score: number }[] = [];

      for (const rows of queryResults) {
        for (const row of rows) {
          const nodeId = String(row.id);
          if (seen.has(nodeId)) continue;
          seen.add(nodeId);

          const text = row.text ?? row.content ?? row.description ?? null;
          if (text) {
            const score = row.score ?? 0;
            allNeighbors.push({
              text,
              importance: row.importance ?? row.stability,
              accessCount: row.accessCount,
              timestamp: row.timestamp,
              table: String(row.table ?? "unknown"),
              id: nodeId,
              score,
            });
            if (RECORD_ID_RE.test(nodeId)) {
              nextFrontier.push({ id: nodeId, score });
            }
          }
        }
      }

      frontier = nextFrontier
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FRONTIER_PER_HOP)
        .map((n) => n.id);
    }

    return allNeighbors;
  }

  async bumpAccessCounts(ids: string[]): Promise<void> {
    const validated = ids.filter(id => { try { assertRecordId(id); return true; } catch { return false; } });
    if (validated.length === 0) return;
    try {
      // Direct interpolation (safe: assertRecordId validates format above).
      // Cannot use `UPDATE $ids` binding — SurrealDB treats string arrays as
      // literal strings, not record references, causing silent no-ops.
      const stmts = validated.map(id =>
        `UPDATE ${id} SET access_count += 1, last_accessed = time::now()`,
      );
      await this.queryBatch(stmts);
    } catch (e) {
      swallow.warn("surreal:bumpAccessCounts", e);
    }
  }

  // ── Concept / Memory / Artifact CRUD ───────────────────────────────────

  async upsertConcept(
    content: string,
    embedding: number[] | null,
    source?: string,
  ): Promise<string> {
    if (!content?.trim()) return "";
    content = content.trim();
    const rows = await this.queryFirst<{ id: string }>(
      `SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) LIMIT 1`,
      { content },
    );
    if (rows.length > 0) {
      const id = String(rows[0].id);
      // Backfill embedding if the existing concept is missing one
      if (embedding?.length) {
        await this.queryExec(
          `UPDATE ${id} SET access_count += 1, last_accessed = time::now(), embedding = IF embedding IS NONE OR array::len(embedding) = 0 THEN $emb ELSE embedding END`,
          { emb: embedding },
        );
      } else {
        await this.queryExec(
          `UPDATE ${id} SET access_count += 1, last_accessed = time::now()`,
        );
      }
      return id;
    }
    const emb = embedding?.length ? embedding : undefined;
    const record: Record<string, unknown> = { content, source: source ?? undefined };
    if (emb) record.embedding = emb;
    const created = await this.queryFirst<{ id: string }>(
      `CREATE concept CONTENT $record RETURN id`,
      { record },
    );
    return String(created[0]?.id ?? "");
  }

  async createArtifact(
    path: string,
    type: string,
    description: string,
    embedding: number[] | null,
  ): Promise<string> {
    const record: Record<string, unknown> = { path, type, description };
    if (embedding?.length) record.embedding = embedding;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE artifact CONTENT $record RETURN id`,
      { record },
    );
    return String(rows[0]?.id ?? "");
  }

  async createMemory(
    text: string,
    embedding: number[] | null,
    importance: number,
    category?: string,
    sessionId?: string,
  ): Promise<string> {
    const source = category ?? "general";

    if (embedding?.length) {
      const dupes = await this.queryFirst<{
        id: string;
        importance: number;
        score: number;
      }>(
        `SELECT id, importance,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND category = $cat
         ORDER BY score DESC
         LIMIT 1`,
        { vec: embedding, cat: source },
      );
      if (dupes.length > 0 && dupes[0].score > 0.92) {
        const existing = dupes[0];
        const newImp = Math.max(existing.importance ?? 0, importance);
        await this.queryExec(
          `UPDATE ${String(existing.id)} SET access_count += 1, importance = $imp, last_accessed = time::now()`,
          { imp: newImp },
        );
        return String(existing.id);
      }
    }

    const record: Record<string, unknown> = { text, importance, category: source, source };
    if (embedding?.length) record.embedding = embedding;
    if (sessionId) record.session_id = sessionId;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE memory CONTENT $record RETURN id`,
      { record },
    );
    return String(rows[0]?.id ?? "");
  }

  async createMonologue(
    sessionId: string,
    category: string,
    content: string,
    embedding: number[] | null,
  ): Promise<string> {
    const record: Record<string, unknown> = { session_id: sessionId, category, content };
    if (embedding?.length) record.embedding = embedding;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE monologue CONTENT $record RETURN id`,
      { record },
    );
    return String(rows[0]?.id ?? "");
  }

  // ── Core Memory (Tier 0/1) ─────────────────────────────────────────────

  async getAllCoreMemory(tier?: number): Promise<CoreMemoryEntry[]> {
    try {
      if (tier != null) {
        return await this.queryFirst<CoreMemoryEntry>(
          `SELECT * FROM core_memory WHERE active = true AND tier = $tier ORDER BY priority DESC`,
          { tier },
        );
      }
      return await this.queryFirst<CoreMemoryEntry>(
        `SELECT * FROM core_memory WHERE active = true ORDER BY tier ASC, priority DESC`,
      );
    } catch (e) {
      swallow.warn("surreal:getAllCoreMemory", e);
      return [];
    }
  }

  async createCoreMemory(
    text: string,
    category: string,
    priority: number,
    tier: number,
    sessionId?: string,
  ): Promise<string> {
    const record: Record<string, unknown> = { text, category, priority, tier, active: true };
    if (sessionId) record.session_id = sessionId;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE core_memory CONTENT $record RETURN id`,
      { record },
    );
    const id = String(rows[0]?.id ?? "");
    if (!id) throw new Error("createCoreMemory: CREATE returned no ID");
    return id;
  }

  async updateCoreMemory(
    id: string,
    fields: Partial<Pick<CoreMemoryEntry, "text" | "category" | "priority" | "tier" | "active">>,
  ): Promise<boolean> {
    assertRecordId(id);
    const ALLOWED_FIELDS = new Set(["text", "category", "priority", "tier", "active"]);
    const sets: string[] = [];
    const bindings: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined && ALLOWED_FIELDS.has(key)) {
        sets.push(`${key} = $${key}`);
        bindings[key] = val;
      }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = time::now()");
    const rows = await this.queryFirst<{ id: string }>(
      `UPDATE ${id} SET ${sets.join(", ")} RETURN id`,
      bindings,
    );
    return rows.length > 0;
  }

  async deleteCoreMemory(id: string): Promise<void> {
    assertRecordId(id);
    await this.queryExec(
      `UPDATE ${id} SET active = false, updated_at = time::now()`,
    );
  }

  async deactivateSessionMemories(sessionId: string): Promise<void> {
    try {
      await this.queryExec(
        `UPDATE core_memory SET active = false, updated_at = time::now() WHERE session_id = $sid AND tier = 1`,
        { sid: sessionId },
      );
    } catch (e) {
      swallow.warn("surreal:deactivateSessionMemories", e);
    }
  }

  // ── Wakeup & lifecycle queries ─────────────────────────────────────────

  async getLatestHandoff(): Promise<{ text: string; created_at: string } | null> {
    try {
      const rows = await this.queryFirst<{ text: string; created_at: string }>(
        `SELECT text, created_at FROM memory WHERE category = "handoff" ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    } catch (e) {
      swallow.warn("surreal:getLatestHandoff", e);
      return null;
    }
  }

  async countResolvedSinceHandoff(handoffCreatedAt: string): Promise<number> {
    try {
      const rows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory WHERE status = 'resolved' AND resolved_at > $ts GROUP ALL`,
        { ts: handoffCreatedAt },
      );
      return rows[0]?.count ?? 0;
    } catch (e) {
      swallow.warn("surreal:countResolvedSinceHandoff", e);
      return 0;
    }
  }

  async getAllIdentityChunks(): Promise<{ text: string }[]> {
    try {
      return await this.queryFirst<{ text: string }>(
        `SELECT text, chunk_index FROM identity_chunk ORDER BY chunk_index ASC`,
      );
    } catch (e) {
      swallow.warn("surreal:getAllIdentityChunks", e);
      return [];
    }
  }

  async getRecentMonologues(
    limit = 5,
  ): Promise<{ category: string; content: string; timestamp: string }[]> {
    try {
      return await this.queryFirst<{ category: string; content: string; timestamp: string }>(
        `SELECT category, content, timestamp FROM monologue ORDER BY timestamp DESC LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getRecentMonologues", e);
      return [];
    }
  }

  async getPreviousSessionTurns(
    currentSessionId?: string,
    limit = 10,
  ): Promise<{ role: string; text: string; tool_name?: string; timestamp: string }[]> {
    try {
      let prevSessionQuery: string;
      const bindings: Record<string, unknown> = { lim: limit };

      if (currentSessionId) {
        prevSessionQuery = `SELECT id, started_at FROM session WHERE id != $current ORDER BY started_at DESC LIMIT 1`;
        bindings.current = currentSessionId;
      } else {
        prevSessionQuery = `SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 1`;
      }

      const sessionRows = await this.queryFirst<{ id: string }>(prevSessionQuery, bindings);
      if (sessionRows.length === 0) return [];

      const prevSessionId = String(sessionRows[0].id);
      const turns = await this.queryFirst<{
        role: string;
        text: string;
        tool_name?: string;
        timestamp: string;
      }>(
        `SELECT role, text, tool_name, timestamp FROM turn
         WHERE id IN (SELECT VALUE in FROM part_of WHERE out = $sid)
           AND text != NONE AND text != ""
         ORDER BY timestamp DESC LIMIT $lim`,
        { sid: prevSessionId, lim: limit },
      );

      return turns.reverse();
    } catch (e) {
      swallow.warn("surreal:getPreviousSessionTurns", e);
      return [];
    }
  }

  async getUnresolvedMemories(
    limit = 5,
  ): Promise<{ id: string; text: string; importance: number; category: string }[]> {
    try {
      return await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
      }>(
        `SELECT id, text,
                math::max([importance - math::min([math::floor(duration::days(time::now() - created_at) / 7), 3]), 0]) AS importance,
                category
         FROM memory
         WHERE (status IS NONE OR status != 'resolved')
           AND category NOT IN ['handoff', 'monologue', 'reflection', 'compaction', 'consolidation']
           AND importance >= 6
         ORDER BY importance DESC
         LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getUnresolvedMemories", e);
      return [];
    }
  }

  async getRecentFailedCausal(
    limit = 3,
  ): Promise<{ description: string; chain_type: string }[]> {
    try {
      return await this.queryFirst<{ description: string; chain_type: string }>(
        `SELECT description, chain_type, created_at FROM causal_chain WHERE success = false ORDER BY created_at DESC LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getRecentFailedCausal", e);
      return [];
    }
  }

  async resolveMemory(memoryId: string): Promise<boolean> {
    try {
      assertRecordId(memoryId);
      await this.queryFirst(
        `UPDATE ${memoryId} SET status = 'resolved', resolved_at = time::now()`,
      );
      return true;
    } catch (e) {
      swallow.warn("surreal:resolveMemory", e);
      return false;
    }
  }

  // ── Utility cache ──────────────────────────────────────────────────────

  async updateUtilityCache(memoryId: string, utilization: number): Promise<void> {
    try {
      await this.queryExec(
        `UPSERT memory_utility_cache SET
          memory_id = $mid,
          retrieval_count += 1,
          avg_utilization = IF retrieval_count > 1
            THEN (avg_utilization * (retrieval_count - 1) + $util) / retrieval_count
            ELSE $util
          END,
          last_updated = time::now()
         WHERE memory_id = $mid`,
        { mid: memoryId, util: utilization },
      );
    } catch (e) {
      swallow.warn("surreal:updateUtilityCache", e);
    }
  }

  async getUtilityFromCache(ids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    try {
      const rows = await this.queryFirst<{
        memory_id: string;
        avg_utilization: number;
      }>(
        `SELECT memory_id, avg_utilization FROM memory_utility_cache WHERE memory_id IN $ids`,
        { ids },
      );
      for (const row of rows) {
        if (row.avg_utilization != null) result.set(String(row.memory_id), row.avg_utilization);
      }
    } catch (e) {
      swallow.warn("surreal:getUtilityFromCache", e);
    }
    return result;
  }

  async getUtilityCacheEntries(ids: string[]): Promise<Map<string, UtilityCacheEntry>> {
    const result = new Map<string, UtilityCacheEntry>();
    if (ids.length === 0) return result;
    try {
      const rows = await this.queryFirst<{
        memory_id: string;
        avg_utilization: number;
        retrieval_count: number;
      }>(
        `SELECT memory_id, avg_utilization, retrieval_count FROM memory_utility_cache WHERE memory_id IN $ids`,
        { ids },
      );
      for (const row of rows) {
        if (row.avg_utilization != null) {
          result.set(String(row.memory_id), {
            avg_utilization: row.avg_utilization,
            retrieval_count: row.retrieval_count ?? 0,
          });
        }
      }
    } catch (e) {
      swallow.warn("surreal:getUtilityCacheEntries", e);
    }
    return result;
  }

  // ── Maintenance operations ─────────────────────────────────────────────

  async runMemoryMaintenance(): Promise<void> {
    try {
      // Single round-trip to reduce transaction conflict window
      await this.queryExec(`
        UPDATE memory SET importance = math::max([importance * 0.95, 2.0]) WHERE importance > 2.0;
        UPDATE memory SET importance = math::max([importance, 3 + ((
          SELECT VALUE avg_utilization FROM memory_utility_cache WHERE memory_id = string::concat(meta::tb(id), ":", meta::id(id)) LIMIT 1
        )[0] ?? 0) * 4]) WHERE importance < 7;
      `);
    } catch (e) {
      // Transaction conflicts expected when daemon writes concurrently — silent
      swallow("surreal:runMemoryMaintenance", e);
    }
  }

  async garbageCollectMemories(): Promise<number> {
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      if (count <= 200) return 0;

      const pruned = await this.db.query(
        `LET $stale = (
          SELECT id FROM memory
          WHERE created_at < time::now() - 14d
            AND importance <= 2.0
            AND (access_count = 0 OR access_count IS NONE)
            AND string::concat("memory:", id) NOT IN (
              SELECT VALUE memory_id FROM (
                SELECT memory_id FROM retrieval_outcome
                WHERE utilization > 0.2
                GROUP BY memory_id
              )
            )
          LIMIT 50
        );
        FOR $m IN $stale { DELETE $m.id; };
        RETURN array::len($stale);`,
      );
      return Number(pruned ?? 0);
    } catch (e) {
      swallow.warn("surreal:garbageCollectMemories", e);
      return 0;
    }
  }

  async archiveOldTurns(): Promise<number> {
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM turn GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      if (count <= 2000) return 0;

      const archived = await this.queryMulti<number>(
        `LET $stale = (SELECT id FROM turn WHERE timestamp < time::now() - 7d AND id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn'));
         FOR $t IN $stale {
           INSERT INTO turn_archive (SELECT * FROM ONLY $t.id);
           DELETE $t.id;
         };
         RETURN array::len($stale);`,
      );
      return Number(archived ?? 0);
    } catch (e) {
      swallow.warn("surreal:archiveOldTurns", e);
      return 0;
    }
  }

  async consolidateMemories(embedFn: (text: string) => Promise<number[]>): Promise<number> {
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      if (count <= 50) return 0;

      let merged = 0;
      const seen = new Set<string>();

      // Pass 1: Vector similarity dedup
      const embMemories = await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
        access_count: number;
        embedding: number[];
      }>(
        `SELECT id, text, importance, category, access_count, embedding, created_at
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
         ORDER BY created_at ASC
         LIMIT 50`,
      );

      for (const mem of embMemories) {
        if (seen.has(String(mem.id))) continue;

        const dupes = await this.queryFirst<{
          id: string;
          importance: number;
          access_count: number;
          score: number;
        }>(
          `SELECT id, importance, access_count,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM memory
           WHERE id != $mid
             AND category = $cat
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`,
          { vec: mem.embedding, mid: mem.id, cat: mem.category },
        );

        for (const dupe of dupes) {
          if (dupe.score < 0.88) break;
          if (seen.has(String(dupe.id))) continue;

          const keepMem =
            mem.importance > dupe.importance ||
            (mem.importance === dupe.importance &&
              (mem.access_count ?? 0) >= (dupe.access_count ?? 0));
          const [keep, drop] = keepMem ? [mem.id, dupe.id] : [dupe.id, mem.id];
          assertRecordId(String(keep));
          assertRecordId(String(drop));
          await this.queryExec(
            `UPDATE ${String(keep)} SET access_count += 1, importance = math::max([importance, $imp])`,
            { imp: dupe.importance },
          );
          await this.queryExec(`DELETE ${String(drop)}`);
          seen.add(String(drop));
          merged++;
        }
      }

      // Pass 2: Backfill embeddings for memories missing them
      const unembedded = await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
        access_count: number;
      }>(
        `SELECT id, text, importance, category, access_count
         FROM memory
         WHERE embedding IS NONE OR array::len(embedding) = 0
         LIMIT 20`,
      );

      for (const mem of unembedded) {
        if (seen.has(String(mem.id))) continue;
        try {
          const emb = await embedFn(mem.text);
          if (!emb) continue;
          await this.queryExec(
            `UPDATE ${String(mem.id)} SET embedding = $emb`,
            { emb },
          );

          const dupes = await this.queryFirst<{
            id: string;
            importance: number;
            access_count: number;
            score: number;
          }>(
            `SELECT id, importance, access_count,
                    vector::similarity::cosine(embedding, $vec) AS score
             FROM memory
             WHERE id != $mid
               AND category = $cat
               AND embedding != NONE AND array::len(embedding) > 0
             ORDER BY score DESC
             LIMIT 3`,
            { vec: emb, mid: mem.id, cat: mem.category },
          );
          for (const dupe of dupes) {
            if (dupe.score < 0.88) break;
            if (seen.has(String(dupe.id))) continue;
            const keepMem =
              mem.importance > dupe.importance ||
              (mem.importance === dupe.importance &&
                (mem.access_count ?? 0) >= (dupe.access_count ?? 0));
            const [keep, drop] = keepMem ? [mem.id, dupe.id] : [dupe.id, mem.id];
            assertRecordId(String(keep));
            assertRecordId(String(drop));
            await this.queryExec(
              `UPDATE ${String(keep)} SET access_count += 1, importance = math::max([importance, $imp])`,
              { imp: dupe.importance },
            );
            await this.queryExec(`DELETE ${String(drop)}`);
            seen.add(String(drop));
            merged++;
          }
        } catch (e) {
          swallow.warn("surreal:consolidate-backfill", e);
        }
      }

      return merged;
    } catch (e) {
      swallow.warn("surreal:consolidateMemories", e);
      return 0;
    }
  }

  // ── Retrieval session memory ───────────────────────────────────────────

  async getSessionRetrievedMemories(
    sessionId: string,
  ): Promise<{ id: string; text: string }[]> {
    try {
      const rows = await this.queryFirst<{ memory_id: string }>(
        `SELECT memory_id FROM retrieval_outcome WHERE session_id = $sid AND memory_table = 'memory' GROUP BY memory_id`,
        { sid: sessionId },
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.memory_id).filter(Boolean);
      if (ids.length === 0) return [];
      // Direct interpolation — SurrealDB treats string-array bindings as
      // literal strings, not record references, causing silent empty results.
      const validated = ids.filter(id => { try { assertRecordId(String(id)); return true; } catch { return false; } });
      if (validated.length === 0) return [];
      const idList = validated.join(", ");
      return this.queryFirst<{ id: string; text: string }>(
        `SELECT id, text FROM memory WHERE id IN [${idList}] AND (status = 'active' OR status IS NONE)`,
      );
    } catch (e) {
      swallow.warn("surreal:getSessionRetrievedMemories", e);
      return [];
    }
  }

  // ── Fibonacci resurfacing ──────────────────────────────────────────────

  async markSurfaceable(memoryId: string): Promise<void> {
    await this.queryExec(
      `UPDATE $id SET surfaceable = true, fib_index = 0, surface_count = 0, next_surface_at = time::now() + 1d`,
      { id: memoryId },
    );
  }

  async getDueMemories(
    limit = 5,
  ): Promise<
    {
      id: string;
      text: string;
      importance: number;
      fib_index: number;
      surface_count: number;
      created_at: string;
    }[]
  > {
    return (
      (await this.queryFirst<any>(
        `SELECT id, text, importance, fib_index, surface_count, created_at
         FROM memory
         WHERE surfaceable = true
           AND next_surface_at <= time::now()
           AND status = 'active'
         ORDER BY importance DESC
         LIMIT $lim`,
        { lim: limit },
      )) ?? []
    );
  }

  // ── Compaction checkpoints ─────────────────────────────────────────────

  async createCompactionCheckpoint(
    sessionId: string,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE compaction_checkpoint CONTENT $data RETURN id`,
      {
        data: {
          session_id: sessionId,
          msg_range_start: rangeStart,
          msg_range_end: rangeEnd,
          status: "pending",
        },
      },
    );
    return String(rows[0]?.id ?? "");
  }

  async completeCompactionCheckpoint(
    checkpointId: string,
    memoryId: string,
  ): Promise<void> {
    assertRecordId(checkpointId);
    await this.queryExec(
      `UPDATE ${checkpointId} SET status = "complete", memory_id = $mid`,
      { mid: memoryId },
    );
  }

  async getPendingCheckpoints(
    sessionId: string,
  ): Promise<{ id: string; msg_range_start: number; msg_range_end: number }[]> {
    return this.queryFirst<{
      id: string;
      msg_range_start: number;
      msg_range_end: number;
    }>(
      `SELECT id, msg_range_start, msg_range_end FROM compaction_checkpoint WHERE session_id = $sid AND (status = "pending" OR status = "failed")`,
      { sid: sessionId },
    );
  }

  // ── Availability check ────────────────────────────────────────────────

  isAvailable(): boolean {
    try {
      return this.db?.isConnected ?? false;
    } catch {
      return false;
    }
  }

  // ── Reflection session lookup ─────────────────────────────────────────

  private _reflectionSessions: Set<string> | null = null;

  clearReflectionCache(): void {
    this._reflectionSessions = null;
  }

  async getReflectionSessionIds(): Promise<Set<string>> {
    if (this._reflectionSessions) return this._reflectionSessions;
    try {
      const rows = await this.queryFirst<{ session_id: string }>(
        `SELECT session_id FROM reflection GROUP BY session_id`,
      );
      this._reflectionSessions = new Set(rows.map(r => r.session_id).filter(Boolean));
    } catch (e) {
      swallow.warn("surreal:getReflectionSessionIds", e);
      this._reflectionSessions = new Set();
    }
    return this._reflectionSessions;
  }

  // ── Fibonacci resurfacing: advance ────────────────────────────────────

  private static readonly FIB_DAYS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

  async advanceSurfaceFade(memoryId: string): Promise<void> {
    const current = await this.queryFirst<{ fib_index: number }>(
      `SELECT fib_index FROM $id`, { id: memoryId },
    );
    const idx = (current as { fib_index: number }[] | undefined)?.[0]?.fib_index ?? 0;
    const nextIdx = Math.min(idx + 1, SurrealStore.FIB_DAYS.length - 1);
    const days = nextIdx < SurrealStore.FIB_DAYS.length
      ? SurrealStore.FIB_DAYS[nextIdx]
      : SurrealStore.FIB_DAYS[SurrealStore.FIB_DAYS.length - 1];
    await this.queryExec(
      `UPDATE $id SET fib_index = $nextIdx, surface_count += 1, last_surfaced = time::now(), next_surface_at = time::now() + type::duration($dur)`,
      { id: memoryId, nextIdx, dur: `${days}d` },
    );
  }

  async resolveSurfaceMemory(memoryId: string, outcome: "engaged" | "dismissed"): Promise<void> {
    await this.queryExec(
      `UPDATE $id SET surfaceable = false, last_engaged = time::now(), surface_outcome = $outcome`,
      { id: memoryId, outcome },
    );
  }

  // ── Dispose ───────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    try {
      await this.close();
    } catch (e) {
      swallow("surreal:dispose", e);
    }
  }
}

export { assertRecordId, assertValidEdge, VALID_EDGES };
