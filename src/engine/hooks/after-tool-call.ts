/**
 * after_tool_call hook — artifact tracking + tool outcome recording.
 */

import type { GlobalPluginState } from "../state.js";
import { recordToolOutcome } from "../retrieval-quality.js";
import { swallow } from "../errors.js";
import { linkToRelevantConcepts } from "../concept-extract.js";

export function createAfterToolCallHandler(state: GlobalPluginState) {
  return async (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      toolCallId?: string;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
    const session = state.getSession(sessionKey);
    if (!session) return;

    const isError = !!event.error;
    recordToolOutcome(!isError);

    // Store tool result snippet
    const resultText = typeof event.result === "string"
      ? event.result.slice(0, 500)
      : JSON.stringify(event.result ?? "").slice(0, 500);

    let toolResultTurnId: string | undefined;
    try {
      toolResultTurnId = await state.store.upsertTurn({
        session_id: session.sessionId,
        role: "tool",
        text: `[${event.toolName}] ${resultText}`,
        embedding: null,
      });

      // Link tool result turn back to the assistant turn that triggered it.
      // If the assistant turn hasn't been ingested yet (afterTurn fires later),
      // eagerly create it so we have a record ID to link against.
      if (toolResultTurnId) {
        if (!session.lastAssistantTurnId && session.lastAssistantText) {
          try {
            const assistantTurnId = await state.store.upsertTurn({
              session_id: session.sessionId,
              role: "assistant",
              text: session.lastAssistantText,
              embedding: null,
            });
            if (assistantTurnId) session.lastAssistantTurnId = assistantTurnId;
          } catch (e) {
            swallow.warn("hook:afterToolCall:eagerAssistantTurn", e);
          }
        }
        if (session.lastAssistantTurnId) {
          await state.store.relate(toolResultTurnId, "tool_result_of", session.lastAssistantTurnId)
            .catch(e => swallow.warn("hook:afterToolCall:tool_result_of", e));
        }
      }
    } catch (e) {
      swallow.warn("hook:afterToolCall:store", e);
    }

    // Auto-track file artifacts from write/edit tools
    if (!isError) {
      // Fire-and-forget: artifact tracking is best-effort enrichment, not critical path
      trackArtifact(event.toolName, event.params, session.taskId, session.projectId, state)
        .catch(e => swallow.warn("hook:afterToolCall:artifact", e));
    }

    // Clean up pending args
    if (event.toolCallId) {
      session.pendingToolArgs.delete(event.toolCallId);
    }
  };
}

async function trackArtifact(
  toolName: string,
  args: Record<string, unknown>,
  taskId: string,
  projectId: string,
  state: GlobalPluginState,
): Promise<void> {
  const ARTIFACT_TOOLS: Record<string, string> = {
    write: "created", edit: "edited", bash: "shell",
  };
  const action = ARTIFACT_TOOLS[toolName];
  if (!action) return;

  let description: string | null = null;

  if (toolName === "write" && args.path) {
    description = `File created: ${args.path}`;
  } else if (toolName === "edit" && args.path) {
    description = `File edited: ${args.path}`;
  } else if (toolName === "bash" && typeof args.command === "string") {
    const cmd = args.command;
    if (/\b(cp|mv|touch|mkdir|npm init|git init|tsc)\b/.test(cmd)) {
      description = `Shell: ${cmd.slice(0, 200)}`;
    } else {
      return;
    }
  }

  if (!description) return;

  let emb: number[] | null = null;
  if (state.embeddings.isAvailable()) {
    try { emb = await state.embeddings.embed(description); } catch { /* ok */ }
  }

  const ext = (args.path as string)?.split(".").pop() ?? "unknown";
  const artifactId = await state.store.createArtifact(
    (args.path as string) ?? "shell", ext, description, emb,
  );
  if (artifactId) {
    if (taskId) {
      await state.store.relate(taskId, "produced", artifactId)
        .catch(e => swallow.warn("artifact:relate", e));
    }
    // used_in: artifact → project
    if (projectId) {
      await state.store.relate(artifactId, "used_in", projectId)
        .catch(e => swallow.warn("artifact:used_in", e));
    }
    // Link artifact to concepts it mentions (embedding-based similarity)
    await linkToRelevantConcepts(
      artifactId, "artifact_mentions", description,
      state.store, state.embeddings, "artifact:concepts",
      5, 0.65, emb,
    );
  }
}
