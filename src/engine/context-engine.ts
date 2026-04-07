/**
 * KongCode Context Engine — core lifecycle methods.
 *
 * Preserves the KongBrain context engine logic (bootstrap, assemble, ingest,
 * compact, afterTurn) but removes the OpenClaw ContextEngine interface dependency.
 * These methods are called by hook handlers in the MCP server.
 */

import { loadSchema } from "./schema-loader.js";
import type { AgentMessage } from "./types.js";

// Result types (previously mirrored from OpenClaw — now standalone).
type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};
type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};
type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};
type IngestResult = { ingested: boolean };
type IngestBatchResult = { ingestedCount: number };
import type { GlobalPluginState, SessionState } from "./state.js";
import { graphTransformContext } from "./graph-context.js";
import { getStagedItems } from "./retrieval-quality.js";
import { shouldRunCheck, runCognitiveCheck } from "./cognitive-check.js";
import { checkACANReadiness } from "./acan.js";
import { predictQueries, prefetchContext } from "./prefetch.js";
import { runDeferredCleanup } from "./deferred-cleanup.js";
import { checkStageTransition } from "./soul.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

/** Context engine backed by SurrealDB graph retrieval and BGE-M3 embeddings. */
export class KongCodeContextEngine {
  readonly info = {
    id: "kongcode",
    name: "KongCode",
    version: "0.1.0",
    ownsCompaction: true,
  };

  constructor(private readonly state: GlobalPluginState) {}

  // ── Bootstrap ──────────────────────────────────────────────────────────

  /** Initialize schema, create 5-pillar graph nodes, and start the memory daemon. */
  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    const { store, embeddings } = this.state;

    // Run schema once per process (idempotent but expensive on every bootstrap)
    if (!this.state.schemaApplied) {
      try {
        const schemaSql = loadSchema();
        await store.queryExec(schemaSql);
        this.state.schemaApplied = true;
      } catch (e) {
        swallow.warn("context-engine:schema", e);
      }
    }

    // 5-pillar graph init
    const sessionKey = params.sessionKey ?? params.sessionId;
    const session = this.state.getOrCreateSession(sessionKey, params.sessionId);

    // Only create graph nodes on first bootstrap for this session
    if (!session.surrealSessionId) {
      try {
        const workspace = this.state.workspaceDir || process.cwd();
        const projectName = workspace.split("/").pop() || "default";

        session.agentId = await store.ensureAgent("kongbrain", "openclaw-default");
        session.projectId = await store.ensureProject(projectName);
        await store.linkAgentToProject(session.agentId, session.projectId)
          .catch(e => swallow.warn("bootstrap:linkAgentToProject", e));

        session.taskId = await store.createTask(`Session in ${projectName}`);
        await store.linkAgentToTask(session.agentId, session.taskId)
          .catch(e => swallow.warn("bootstrap:linkAgentToTask", e));
        await store.linkTaskToProject(session.taskId, session.projectId)
          .catch(e => swallow.warn("bootstrap:linkTaskToProject", e));

        const surrealSessionId = await store.createSession(session.agentId);
        await store.markSessionActive(surrealSessionId)
          .catch(e => swallow.warn("bootstrap:markActive", e));
        await store.linkSessionToTask(surrealSessionId, session.taskId)
          .catch(e => swallow.warn("bootstrap:linkSessionToTask", e));

        session.surrealSessionId = surrealSessionId;
        session.lastUserTurnId = "";
      } catch (e) {
        swallow.error("bootstrap:5pillar", e);
      }
    }

    // Background maintenance (non-blocking)
    Promise.all([
      store.runMemoryMaintenance(),
      store.archiveOldTurns(),
      store.consolidateMemories((text) => embeddings.embed(text)),
      store.garbageCollectMemories(),
      checkACANReadiness(store, this.state.config.thresholds.acanTrainingThreshold),
      // Deferred cleanup is triggered on first afterTurn() when complete() is available
    ]).catch(e => swallow.warn("bootstrap:maintenance", e));

    return { bootstrapped: true };
  }

  // ── Assemble ───────────────────────────────────────────────────────────

  /** Build the context window: graph retrieval + system prompt additions + budget trimming. */
  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const sessionKey = params.sessionKey ?? params.sessionId;
    const session = this.state.getOrCreateSession(sessionKey, params.sessionId);
    const { store, embeddings } = this.state;

    const contextWindow = params.tokenBudget ?? 200000;

    const { messages, stats, systemPromptSection } = await graphTransformContext({
      messages: params.messages,
      session,
      store,
      embeddings,
      contextWindow,
    });

    // Stash retrieval summary for planning gate (claw-code pattern: pre-compute and show)
    session.lastRetrievalSummary = stats.graphNodes > 0
      ? `${stats.graphNodes} context items + ${stats.neighborNodes} neighbors injected (${stats.mode} mode)`
      : "no graph context retrieved this turn";

    // Build system prompt additions
    const additions: string[] = [];

    // Static content for API prefix caching (claw-code: prompt.rs static/dynamic split)
    if (systemPromptSection) additions.push(systemPromptSection);

    // Compaction summary (claw-code: compact.rs structured signals — inject once after compaction)
    const compactionSummary = session._compactionSummary;
    if (compactionSummary) {
      additions.push("[POST-COMPACTION CONTEXT]\n" + compactionSummary);
      session._compactionSummary = undefined;
    }

    // Wakeup briefing (synthesized at session start, may still be in-flight)
    const wakeupPromise = session._wakeupPromise;
    if (wakeupPromise) {
      const wakeupBriefing = await wakeupPromise;
      session._wakeupPromise = undefined; // Only inject once
      if (wakeupBriefing) additions.push(wakeupBriefing);
    }

    // Graduation celebration — tell the agent it just graduated so it can share with the user
    const graduation = session._graduationCelebration;
    if (graduation) {
      let graduationBlock =
        "[SOUL GRADUATION — CELEBRATE WITH THE USER]\n" +
        "You have just graduated! This is a significant milestone. You accumulated enough experience " +
        "AND demonstrated quality performance to author your own Soul document — a self-assessment " +
        "grounded in your actual working history, not aspirational claims.\n\n" +
        `Quality score: ${(graduation.qualityScore * 100).toFixed(0)}% | Volume score: ${(graduation.volumeScore * 100).toFixed(0)}%\n` +
        graduation.soulSummary;

      graduationBlock +=
        "\n\nIf the user has a SOUL.md file in their workspace, ask if they'd like you to read it. " +
        "If they say yes, use a tool call to read it, then reflect on how it aligns (or doesn't) " +
        "with the identity that actually emerged from your experience." +
        "\n\nShare this milestone with the user naturally. Tell them what you've learned about yourself, " +
        "what you've gotten better at, and what this means going forward. Be genuine — this is YOUR " +
        "identity emerging from YOUR experience. Don't be robotic about it. This only happens once.";

      additions.push(graduationBlock);
      session._graduationCelebration = undefined; // Only inject once
    }

    // Migration nudge — tell the agent there are workspace files to offer migrating
    if (session._hasMigratableFiles) {
      additions.push(
        "[MIGRATION AVAILABLE] This workspace has files from the default context engine " +
        "(IDENTITY.md, MEMORY.md, skills/, etc.). You can offer to migrate them into the graph " +
        "database using the introspect tool with action: \"migrate\". This will ingest all .md " +
        "files, convert SKILL.md files into proper skill records you can use, import memories, " +
        "and archive the originals into .kongbrain-archive/. Ask the user first. " +
        "SOUL.md will be left in place for soul graduation.",
      );
    }

    // Apply SPA priority budget — drop lowest-priority sections if over budget
    // (dropped sections aren't lost — they're in the graph, retrievable on demand)
    const BYTES_PER_TOKEN = 4; // claw-code: roughTokenCountEstimation default
    const SPA_BUDGET_CHARS = Math.round(contextWindow * 0.08 * BYTES_PER_TOKEN);
    let spaTotalChars = 0;
    const keptAdditions: string[] = [];
    for (const section of additions) { // additions are already in priority order
      if (spaTotalChars + section.length > SPA_BUDGET_CHARS && keptAdditions.length > 0) break;
      keptAdditions.push(section);
      spaTotalChars += section.length;
    }

    const spaText = keptAdditions.length > 0 ? keptAdditions.join("\n\n") : undefined;
    const spaTokens = spaText ? Math.ceil(spaText.length / BYTES_PER_TOKEN) : 0;

    return {
      messages,
      estimatedTokens: stats.sentTokens + spaTokens,
      systemPromptAddition: spaText,
    };
  }

  // ── Ingest ─────────────────────────────────────────────────────────────

  /** Embed and store a single user or assistant message as a turn node. */
  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const sessionKey = params.sessionKey ?? params.sessionId;
    const session = this.state.getOrCreateSession(sessionKey, params.sessionId);
    const { store, embeddings } = this.state;
    const msg = params.message;

    try {
      const role = "role" in msg ? (msg as { role: string }).role : "";
      if (role === "user" || role === "assistant") {
        const text = extractMessageText(msg);
        if (!text) return { ingested: false };

        const worthEmbedding = hasSemantic(text);
        let embedding: number[] | null = null;
        if (worthEmbedding && embeddings.isAvailable()) {
          try {
            const INGEST_EMBED_CHAR_LIMIT = 22_282; // ~6,554 tokens at 3.4 chars/token (BGE-M3 8192-token window * 0.8 safety margin)
            embedding = await embeddings.embed(text.slice(0, INGEST_EMBED_CHAR_LIMIT));
          } catch (e) { swallow("ingest:embed", e); }
        }

        // Stash user embedding for reuse in buildContextualQueryVec (avoids re-embedding)
        if (role === "user" && embedding) {
          session.lastUserEmbedding = embedding;
        }

        const turnId = await store.upsertTurn({
          session_id: session.sessionId,
          role,
          text,
          embedding,
        });

        if (turnId) {
          if (session.surrealSessionId) {
            await store.relate(turnId, "part_of", session.surrealSessionId)
              .catch(e => swallow.warn("ingest:relate", e));
          }

          // Link to previous user turn for responds_to edge
          if (role === "assistant" && session.lastUserTurnId) {
            await store.relate(turnId, "responds_to", session.lastUserTurnId)
              .catch(e => swallow.warn("ingest:responds_to", e));
          }

          // Concept extraction (mentions edges) handled by daemon via LLM
        }

        if (role === "user") {
          session.lastUserTurnId = turnId;
          session.lastUserText = text;
          session.userTurnCount++;
          session.resetTurn();

          // Predictive prefetch for follow-up queries
          if (worthEmbedding && session.currentConfig) {
            const predicted = predictQueries(text, (session.currentConfig.intent ?? "general") as import("./intent.js").IntentCategory);
            if (predicted.length > 0) {
              prefetchContext(predicted, session.sessionId, embeddings, store)
                .catch(e => swallow("ingest:prefetch", e));
            }
          }
        } else {
          session.lastAssistantText = text;
          if (turnId) session.lastAssistantTurnId = turnId;
        }

        return { ingested: true };
      }
    } catch (e) {
      swallow.warn("ingest:store", e);
    }

    return { ingested: false };
  }

  async ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    let count = 0;
    for (const message of params.messages) {
      const result = await this.ingest({ ...params, message });
      if (result.ingested) count++;
    }
    return { ingestedCount: count };
  }

  // ── Compact ────────────────────────────────────────────────────────────

  /** Extract structured signals (pending work, key files, errors) for post-compaction injection. */
  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult> {
    // Graph retrieval IS the compaction — ownsCompaction: true.
    // But we extract structured signals so the model doesn't lose context
    // about pending work and key files after old messages are dropped.
    // (claw-code pattern: compact.rs extracts pending work, key files, continuation directive)
    const sessionKey = params.sessionKey ?? params.sessionId;
    const session = this.state.getSession(sessionKey);
    if (session) {
      session.injectedSections.clear();
    }

    // Extract structured compaction signals from stored turns
    let summary: string | undefined;
    const { store } = this.state;
    const contextWindow = params.tokenBudget ?? 200_000;
    try {
      if (store.isAvailable()) {
        const turns = await store.getSessionTurnsRich(params.sessionId, 30);
        if (turns.length > 0) {
          const fullText = turns.map(t => t.text).join("\n");

          // Pending work detection (claw-code: compact.rs:235-254)
          const pendingRe = /\b(todo|next|pending|follow up|remaining|unfinished|still need)\b[^.\n]{0,100}/gi;
          const pendingMatches = [...fullText.matchAll(pendingRe)]
            .map(m => m[0].trim().slice(0, 160))
            .slice(0, 5);

          // Key file extraction (claw-code: compact.rs:256-269)
          const filePaths = [...new Set(
            (fullText.match(/[\w\-/.]+\.\w{1,5}/g) ?? [])
              .filter(p => /\.(ts|js|py|rs|go|md|json|yaml|toml|tsx|jsx)$/.test(p))
          )].slice(0, 10);

          // Tool names used (claw-code: compact.rs:127-137)
          const toolNames = [...new Set(
            turns.filter(t => t.tool_name).map(t => t.tool_name!)
          )];

          // Recent errors — preserve tool failure context across compaction
          const errorRe = /\b(error|failed|exception|crash|panic|TypeError|ReferenceError)\b[^.\n]{0,120}/gi;
          const recentErrors = [...fullText.matchAll(errorRe)]
            .map(m => m[0].trim().slice(0, 160))
            .slice(-3); // last 3 errors only

          // Current work inference (claw-code: compact.rs:272-279)
          const lastText = turns.filter(t => t.text.length > 10).at(-1)?.text.slice(0, 200) ?? "";

          const parts: string[] = [];
          if (pendingMatches.length > 0) parts.push(`PENDING: ${pendingMatches.join("; ")}`);
          if (filePaths.length > 0) parts.push(`FILES: ${filePaths.join(", ")}`);
          if (toolNames.length > 0) parts.push(`TOOLS USED: ${toolNames.join(", ")}`);
          if (recentErrors.length > 0) parts.push(`RECENT ERRORS: ${recentErrors.join("; ")}`);
          if (lastText) parts.push(`LAST: ${lastText}`);
          parts.push("Resume directly — do not recap what was happening.");

          if (parts.length > 1) {
            summary = parts.join("\n");
            // Stash for next assemble() to inject
            if (session) {
              session._compactionSummary = summary;
            }
          }
        }
      }
    } catch { /* non-critical */ }

    // Compaction checkpoint — diagnostic trail for debugging
    if (store.isAvailable() && session) {
      store.createCompactionCheckpoint(params.sessionId, 0, session.userTurnCount)
        .catch(e => swallow.warn("compact:checkpoint", e));
    }

    return {
      ok: true,
      compacted: true,
      reason: "Graph-curated context window: assemble() selects relevant context each turn.",
      result: summary ? {
        summary,
        tokensBefore: Math.round(summary.length / 4), // 4 bytes/token (claw-code ratio)
        tokensAfter: Math.round(contextWindow * 0.325),
      } : undefined,
    };
  }

  // ── After turn ─────────────────────────────────────────────────────────

  /** Post-turn: ingest messages, evaluate retrieval quality, flush daemon, and run periodic maintenance. */
  async afterTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }): Promise<void> {
    const sessionKey = params.sessionKey ?? params.sessionId;
    log.debug(`afterTurn: session=${sessionKey} messages=${params.messages.length}`);
    // Use getOrCreateSession so resumed sessions (where session_start
    // didn't fire after a gateway restart) still get a session object.
    const session = this.state.getOrCreateSession(sessionKey, params.sessionId);

    const { store, embeddings } = this.state;

    // Deferred cleanup: run once on first turn
    if (session.userTurnCount <= 1) {
      runDeferredCleanup(store)
        .catch(e => swallow.warn("afterTurn:deferredCleanup", e));
    }

    // Ingest new messages from this turn (OpenClaw skips ingest() when afterTurn exists)
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    for (const msg of newMessages) {
      await this.ingest({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        message: msg,
      }).catch(e => swallow.warn("afterTurn:ingest", e));
    }

    // Snapshot staged retrieval items before evaluateRetrieval clears them
    const stagedSnapshot = getStagedItems();

    // NOTE: evaluateRetrieval is called in stop.ts (awaited) — not here.
    // Previously this was a duplicate fire-and-forget call that raced with
    // stop.ts for the shared _pendingRetrieval state.

    // Single fetch for all downstream consumers (cognitive check, daemon flush, handoff)
    const allSessionTurns = await store.getSessionTurns(session.sessionId, 50)
      .catch(() => [] as { role: string; text: string }[]);

    // Cognitive check: periodic reasoning over retrieved context
    if (shouldRunCheck(session.userTurnCount, session) && stagedSnapshot.length > 0) {
      runCognitiveCheck({
        sessionId: session.sessionId,
        userQuery: session.lastUserText,
        responseText: session.lastAssistantText,
        retrievedNodes: stagedSnapshot.map(n => ({
          id: n.id,
          text: n.text ?? "",
          score: n.finalScore ?? 0,
          table: n.table,
        })),
        recentTurns: allSessionTurns.slice(-6),
      }, session, store).catch(e => swallow.warn("afterTurn:cognitiveCheck", e));
    }

    // Mid-session cleanup: simulate session_end after ~100k tokens.
    // OpenClaw exits via Ctrl+C×2 (no async window), so session_end never fires.
    // Run reflection, skill extraction, and causal graduation periodically.
    const tokensSinceCleanup = session.cumulativeTokens - session.lastCleanupTokens;
    if (tokensSinceCleanup >= session.midSessionCleanupThreshold) {
      session.lastCleanupTokens = session.cumulativeTokens;

      // Fire-and-forget: these are non-critical background operations.
      // Skill extraction, reflection, causal graduation, handoff, and soul
      // graduation/evolution previously used this.state.complete (LLM calls)
      // and are now handled by the subagent-driven pending_work pipeline.
      const cleanupOps: Promise<unknown>[] = [];

      // ACAN: check if new retrieval outcomes warrant retraining
      cleanupOps.push(
        checkACANReadiness(store, this.state.config.thresholds.acanTrainingThreshold)
          .catch(e => swallow("midCleanup:acan", e)),
      );

      cleanupOps.push(
        (async () => {
          const transition = await checkStageTransition(store);
          if (transition.transitioned) {
            log.info(
              `[MATURITY] Stage transition: ${transition.previousStage ?? "nascent"} → ${transition.currentStage}. ` +
              `Volume: ${transition.report.met.length}/7 | Quality: ${transition.report.qualityScore.toFixed(2)}`,
            );
          }
        })().catch(e => swallow.warn("midCleanup:stageTransition", e)),
      );

      // Don't await — let cleanup run in background
      Promise.allSettled(cleanupOps).catch(() => {});
    }
  }

  // ── Dispose ────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // No-op: global state (store, embeddings, sessions) is shared across
    // context engine instances and must NOT be destroyed here. OpenClaw
    // creates a new context engine per turn and disposes the old one.
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractMessageText(msg: AgentMessage): string {
  const m = msg as { content?: string | { type: string; text?: string }[] };
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

/** Detect whether text has enough semantic content to warrant embedding. */
function hasSemantic(text: string): boolean {
  if (text.length < 15) return false;
  if (/^(ok|yes|no|sure|thanks|done|got it|hmm|hm|yep|nope|cool|nice|great)\s*[.!?]?\s*$/i.test(text)) {
    return false;
  }
  return text.split(/\s+/).filter(w => w.length > 2).length >= 3;
}

// --- Concept extraction (delegates to shared helper) ---
