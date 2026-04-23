/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { log } from "../engine/log.js";
import { swallow } from "../engine/errors.js";

export async function handlePreToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const toolName = (payload.tool_name as string) ?? "";
  session.toolCallCount++;
  session.toolCallsSinceLastText++;

  // Planning gate: soft interrupt if over tool budget
  if (session.toolCallCount > session.toolLimit && !session.softInterrupted) {
    session.softInterrupted = true;
    log.debug(`Tool budget soft interrupt: ${session.toolCallCount}/${session.toolLimit}`);
    return makeHookOutput("PreToolUse",
      `[KongCode] Tool budget reached (${session.toolCallCount}/${session.toolLimit}). ` +
        "Consider summarizing progress before making more tool calls.",
    );
  }

  // Redundant recall detection: if user prompt was already retrieved via
  // graphTransformContext, block manual recall with similar query
  if (toolName.includes("recall") && session.lastRetrievalSummary) {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const recallQuery = toolInput?.query as string | undefined;

    if (recallQuery && session.lastRetrievalSummary) {
      // Don't block — just inform that context was already retrieved
      return makeHookOutput("PreToolUse",
        `[KongCode] Context was already auto-retrieved this turn (${session.lastRetrievalSummary}). ` +
          "Only call recall if you need something specific not already in the injected context.",
      );
    }
  }

  // Track pending tool args for artifact extraction in PostToolUse
  if (toolName === "Write" || toolName === "Edit") {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    if (toolInput?.file_path) {
      session.pendingToolArgs.set(toolName, toolInput);
    }
  }

  // Subagent spawn capture (R3). Claude Code's Agent / Task tool invocations
  // fire PreToolUse with rich payload: tool_use_id + tool_input.subagent_type
  // + tool_input.prompt + tool_input.description. Write an initial subagent
  // row here; SubagentStop will complete it. Fire-and-forget; errors swallowed.
  if ((toolName === "Agent" || toolName === "Task") && state.store.isAvailable()) {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const toolUseId = String(payload.tool_use_id ?? "");
    const subagentType = String(toolInput?.subagent_type ?? "general-purpose");
    const description = String(toolInput?.description ?? "").slice(0, 200);
    const prompt = String(toolInput?.prompt ?? "");

    if (toolUseId) {
      (async () => {
        try {
          const rows = await state.store.queryFirst<{ id: string }>(
            `CREATE subagent CONTENT $data RETURN id`,
            {
              data: {
                parent_session_id: session.sessionId,
                agent_type: subagentType,
                description,
                prompt_preview: prompt.slice(0, 500),
                prompt_length: prompt.length,
                outcome: "in_progress",
                correlation_key: toolUseId,
                tool_call_count: 0,
              },
            },
          );
          const subagentId = String(rows[0]?.id ?? "");
          if (subagentId) {
            session._activeSubagents.set(toolUseId, subagentId);
            // spawned_from: subagent → parent session
            if (session.surrealSessionId) {
              await state.store.relate(subagentId, "spawned_from", session.surrealSessionId)
                .catch(e => swallow("preToolUse:subagent:spawned_from", e));
            }
            // derived_from: subagent → task
            if (session.taskId) {
              await state.store.relate(subagentId, "derived_from", session.taskId)
                .catch(e => swallow("preToolUse:subagent:derived_from", e));
            }
            log.info(`[subagent] spawned: type=${subagentType} corr=${toolUseId.slice(0, 8)}`);
          }
        } catch (e) {
          swallow.warn("preToolUse:subagent:create", e);
        }
      })();
    }
  }

  return {};
}
