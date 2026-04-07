/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { log } from "../engine/log.js";

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

  return {};
}
