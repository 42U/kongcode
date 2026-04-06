/**
 * Daemon Manager — runs memory extraction in-process.
 *
 * Originally used a Worker thread, but OpenClaw loads plugins via jiti
 * (TypeScript only, no compiled JS), and Node's Worker constructor requires
 * .js files. Refactored to run extraction async in the main thread.
 * The extraction is I/O-bound (LLM calls + DB writes), not CPU-bound,
 * so in-process execution is fine.
 */
import type { TurnData, PriorExtractions } from "./daemon-types.js";
import type { CompleteFn } from "./state.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import { swallow } from "./errors.js";

export type { TurnData } from "./daemon-types.js";

export interface MemoryDaemon {
  /** Fire-and-forget: send a batch of turns for incremental extraction. */
  sendTurnBatch(
    turns: TurnData[],
    thinking: string[],
    retrievedMemories: { id: string; text: string }[],
    priorExtractions?: PriorExtractions,
  ): void;
  /** Request current daemon status. */
  getStatus(): Promise<{ type: "status"; extractedTurns: number; pendingBatches: number; errors: number }>;
  /** Graceful shutdown: waits for current extraction, then cleans up. */
  shutdown(timeoutMs?: number): Promise<void>;
  /** How many turns has the daemon already extracted? */
  getExtractedTurnCount(): number;
}

export function startMemoryDaemon(
  sharedStore: SurrealStore,
  sharedEmbeddings: EmbeddingService,
  sessionId: string,
  complete: CompleteFn,
  extractionTimeoutMs = 120_000,
  taskId?: string,
  projectId?: string,
): MemoryDaemon {
  // Use shared store/embeddings from global state (no duplicate connections)
  const store = sharedStore;
  const embeddings = sharedEmbeddings;
  let processing = false;
  let shuttingDown = false;
  let extractedTurnCount = 0;
  let errorCount = 0;

  const priorState: PriorExtractions = {
    conceptNames: [], artifactPaths: [], skillNames: [],
  };

  // Import extraction logic lazily to avoid circular deps
  async function runExtraction(
    turns: TurnData[],
    thinking: string[],
    retrievedMemories: { id: string; text: string }[],
    incomingPrior?: PriorExtractions,
  ): Promise<void> {
    if (!store || !embeddings) return;
    if (turns.length < 2) return;

    // Merge incoming prior state
    if (incomingPrior) {
      for (const name of incomingPrior.conceptNames) {
        if (!priorState.conceptNames.includes(name)) priorState.conceptNames.push(name);
      }
      for (const path of incomingPrior.artifactPaths) {
        if (!priorState.artifactPaths.includes(path)) priorState.artifactPaths.push(path);
      }
      for (const name of incomingPrior.skillNames) {
        if (!priorState.skillNames.includes(name)) priorState.skillNames.push(name);
      }
    }

    // Dynamically import the extraction helpers from memory-daemon
    const { buildSystemPrompt, buildTranscript, writeExtractionResults } = await import("./memory-daemon.js");

    const transcript = buildTranscript(turns);
    const sections: string[] = [`[TRANSCRIPT]\n${transcript.slice(0, 30000)}`];

    if (thinking.length > 0) {
      sections.push(`[THINKING]\n${thinking.slice(-3).join("\n---\n").slice(0, 2000)}`);
    }

    if (retrievedMemories.length > 0) {
      const memList = retrievedMemories.map(m => `${m.id}: ${String(m.text).slice(0, 200)}`).join("\n");
      sections.push(`[RETRIEVED MEMORIES]\nMark any that have been fully addressed/fixed/completed.\n${memList}`);
    }

    const systemPrompt = buildSystemPrompt(thinking.length > 0, retrievedMemories.length > 0, priorState);

    // Structured output schema — forces API to return valid JSON (no markdown, no preamble)
    const extractionSchema = {
      type: "object" as const,
      properties: {
        causal: { type: "array", items: { type: "object" } },
        monologue: { type: "array", items: { type: "object" } },
        resolved: { type: "array", items: { type: "string" } },
        concepts: { type: "array", items: { type: "object" } },
        corrections: { type: "array", items: { type: "object" } },
        preferences: { type: "array", items: { type: "object" } },
        artifacts: { type: "array", items: { type: "object" } },
        decisions: { type: "array", items: { type: "object" } },
        skills: { type: "array", items: { type: "object" } },
      },
      required: ["causal", "monologue", "resolved", "concepts", "corrections", "preferences", "artifacts", "decisions", "skills"],
    };

    const response = await complete({
      system: systemPrompt,
      messages: [{ role: "user", content: sections.join("\n\n") }],
      outputFormat: { type: "json_schema", schema: extractionSchema },
    });

    let responseText = response.text;

    // Sanitize: strip BOM, markdown fences, and trim
    responseText = responseText.replace(/^\uFEFF/, "").trim();
    const fenceMatch = responseText.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) responseText = fenceMatch[1].trim();

    // With structured output the response should be valid JSON directly.
    // Fall back to regex extraction if the provider doesn't support outputFormat.
    let result: Record<string, any>;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      swallow.warn("daemon:parseDebug", new Error(
        `JSON.parse failed: ${(parseErr as Error).message}; ` +
        `len=${responseText.length}; first100=${JSON.stringify(responseText.slice(0, 100))}; ` +
        `last100=${JSON.stringify(responseText.slice(-100))}`
      ));
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        swallow.warn("daemon:noJson", new Error(`LLM response contained no JSON (${responseText.length} chars)`));
        return;
      }
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        // Try fixing trailing commas
        try {
          result = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, "$1"));
        } catch {
          // Try stripping control characters
          try {
            const cleaned = jsonMatch[0].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
            result = JSON.parse(cleaned);
          } catch {
            result = {};
            const fields = ["causal", "monologue", "resolved", "concepts", "corrections", "preferences", "artifacts", "decisions", "skills"];
            for (const field of fields) {
              const fieldMatch = jsonMatch[0].match(new RegExp(`"${field}"\\s*:\\s*(\\[[\\s\\S]*?\\])(?=\\s*[,}]\\s*"[a-z]|\\s*\\}$)`, "m"));
              if (fieldMatch) {
                try { result[field] = JSON.parse(fieldMatch[1]); } catch { /* skip */ }
              }
            }
            const PRIMARY_FIELDS = ["causal", "monologue", "artifacts"];
            if (!PRIMARY_FIELDS.some(f => f in result)) {
              swallow.warn("daemon:fallbackFailed", new Error(`Regex fallback extracted no primary fields from: ${jsonMatch[0].slice(0, 100)}`));
              return;
            }
          }
        }
      }
    }

    try {
      const counts = await writeExtractionResults(result, sessionId, store, embeddings, priorState, taskId, projectId, turns);
      extractedTurnCount = turns.length;
    } catch (e) {
      swallow.warn("daemon:writeExtractionResults", e);
    }
  }

  // Pending batch (only keep latest — newer batch supersedes older)
  let pendingBatch: {
    turns: TurnData[];
    thinking: string[];
    retrievedMemories: { id: string; text: string }[];
    priorExtractions?: PriorExtractions;
  } | null = null;

  async function processPending(): Promise<void> {
    if (processing || shuttingDown) return;
    while (pendingBatch) {
      processing = true;
      const batch = pendingBatch;
      pendingBatch = null;
      try {
        await Promise.race([
          runExtraction(batch.turns, batch.thinking, batch.retrievedMemories, batch.priorExtractions),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Extraction timed out after ${extractionTimeoutMs}ms`)), extractionTimeoutMs),
          ),
        ]);
      } catch (e) {
        errorCount++;
        swallow.warn("daemon:extraction", e);
      } finally {
        processing = false;
      }
    }
  }

  return {
    sendTurnBatch(turns, thinking, retrievedMemories, priorExtractions) {
      if (shuttingDown) return;
      if (pendingBatch) {
        // Merge into pending batch instead of discarding — prevents turn data loss
        pendingBatch.turns = [...pendingBatch.turns, ...turns];
        pendingBatch.thinking = [...pendingBatch.thinking, ...thinking];
        pendingBatch.retrievedMemories = [...pendingBatch.retrievedMemories, ...retrievedMemories];
        pendingBatch.priorExtractions = priorExtractions ?? pendingBatch.priorExtractions;
      } else {
        pendingBatch = { turns, thinking, retrievedMemories, priorExtractions };
      }
      // Fire-and-forget
      processPending().catch(e => swallow.warn("daemon:sendBatch", e));
    },

    async getStatus() {
      return {
        type: "status" as const,
        extractedTurns: extractedTurnCount,
        pendingBatches: pendingBatch ? 1 : 0,
        errors: errorCount,
      };
    },

    async shutdown(timeoutMs = 45_000) {
      shuttingDown = true;
      // Wait for current extraction to finish
      if (processing) {
        await new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (!processing) { clearInterval(check); clearTimeout(timeout); resolve(); }
          }, 100);
          const timeout = setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
        });
      }
      // Shared store/embeddings — don't dispose (owned by global state)
    },

    getExtractedTurnCount() {
      return extractedTurnCount;
    },
  };
}
