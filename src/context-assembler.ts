/**
 * Context assembler — extracts graph context as a string for Claude Code hooks.
 *
 * Calls the engine's graphTransformContext and extracts the text content
 * from the injected context message + system prompt section. This preserves
 * 100% of the retrieval logic while adapting the output for hook systemMessage.
 */

import type { GlobalPluginState, SessionState } from "./engine/state.js";
import type { AgentMessage, UserMessage, TextContent } from "./engine/types.js";
import { graphTransformContext } from "./engine/graph-context.js";
import { preflight } from "./engine/orchestrator.js";
import { swallow } from "./engine/errors.js";
import { log } from "./engine/log.js";

/**
 * Run the full context retrieval pipeline and return a formatted string
 * suitable for injection as a Claude Code hook systemMessage.
 *
 * Flow: classifyIntent → vectorSearch → graphExpand → WMR/ACAN scoring
 *       → dedup → budgetTrim → formatContextMessage → extract text
 */
export async function assembleContextString(
  state: GlobalPluginState,
  session: SessionState,
  userPrompt: string,
): Promise<string | undefined> {
  const { store, embeddings } = state;

  if (!store.isAvailable() || !embeddings.isAvailable()) {
    log.warn(`Context assembly skipped: store=${store.isAvailable()}, embeddings=${embeddings.isAvailable()}`);
    return undefined;
  }

  // Run orchestrator preflight to classify intent and set adaptive config
  try {
    const preflightResult = await preflight(userPrompt, session, embeddings);
    session.currentConfig = preflightResult.config;
    if (preflightResult.config.toolLimit != null) {
      session.toolLimit = preflightResult.config.toolLimit;
    }
  } catch (e) {
    swallow.warn("assembleContext:preflight", e);
  }

  // Build a minimal message array for graphTransformContext.
  // In Claude Code, we don't have the full message history — we only have
  // the current user prompt. The engine will retrieve relevant context from
  // the graph to supplement this.
  const messages: AgentMessage[] = [
    { role: "user", content: userPrompt } as UserMessage,
  ];

  try {
    const result = await graphTransformContext({
      messages,
      session,
      store,
      embeddings,
      contextWindow: 200_000,
    });

    const parts: string[] = [];

    // System prompt section (pillars + tier 0 core directives)
    if (result.systemPromptSection) {
      parts.push(result.systemPromptSection);
    }

    // Extract text from injected context messages.
    // graphTransformContext prepends a context message to the message array.
    // We need to find it and extract its text content.
    for (const msg of result.messages) {
      if (msg.role === "user") {
        const text = extractText(msg);
        // The graph context message starts with "[System retrieved context"
        if (text?.includes("<graph_context>")) {
          parts.push(text);
          break;
        }
      }
    }

    // Include wakeup briefing if available and this is the first turn
    if (session.userTurnCount <= 1 && session._wakeupPromise) {
      try {
        const wakeup = await Promise.race([
          session._wakeupPromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
        ]);
        if (wakeup) parts.push(wakeup);
      } catch { /* non-critical */ }
    }

    // Include compaction summary if present
    if (session._compactionSummary) {
      parts.push(session._compactionSummary);
      session._compactionSummary = undefined;
    }

    // Include graduation celebration if present
    if (session._graduationCelebration) {
      const gc = session._graduationCelebration;
      parts.push(
        `[SOUL GRADUATION] Quality: ${gc.qualityScore.toFixed(2)} | Volume: ${gc.volumeScore.toFixed(2)}\n` +
        gc.soulSummary,
      );
      session._graduationCelebration = undefined;
    }

    if (parts.length === 0) return undefined;

    // Store retrieval summary for planning gate
    session.lastRetrievalSummary = `${result.stats.graphNodes} graph nodes, ${result.stats.neighborNodes} neighbors`;
    session.lastQueryVec = null; // Will be set by the retrieval pipeline internally

    log.debug(`Context assembled: ${result.stats.graphNodes} nodes, ${result.stats.mode} mode`);

    return parts.join("\n\n");
  } catch (e) {
    swallow.warn("assembleContext:transform", e);
    return undefined;
  }
}

/**
 * Ingest a user or assistant message into the graph database.
 * Embeds the text and stores it as a turn record with relations.
 */
export async function ingestTurn(
  state: GlobalPluginState,
  session: SessionState,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  const { store, embeddings } = state;
  if (!store.isAvailable() || !text) return;

  // Skip filler messages
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 5 || ["ok", "sure", "yes", "no", "thanks"].includes(trimmed)) return;

  try {
    let embedding: number[] | null = null;
    if (embeddings.isAvailable()) {
      const INGEST_EMBED_CHAR_LIMIT = 22_282;
      embedding = await embeddings.embed(text.slice(0, INGEST_EMBED_CHAR_LIMIT));
    }

    // Stash user embedding for reuse in context retrieval
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
      // Link to session
      if (session.surrealSessionId) {
        await store.relate(turnId, "part_of", session.surrealSessionId)
          .catch(e => swallow("ingest:relate", e));
      }

      // responds_to edge
      if (role === "assistant" && session.lastUserTurnId) {
        await store.relate(turnId, "responds_to", session.lastUserTurnId)
          .catch(e => swallow("ingest:responds_to", e));
      }
    }

    if (role === "user") {
      session.lastUserTurnId = turnId;
    } else {
      session.lastAssistantTurnId = turnId;
    }
  } catch (e) {
    swallow.warn("ingestTurn", e);
  }
}

/** Extract text content from a message. */
function extractText(msg: AgentMessage): string | null {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is TextContent => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }
  return null;
}
