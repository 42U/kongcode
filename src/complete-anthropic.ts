/**
 * Anthropic SDK implementation of the CompleteFn interface.
 *
 * Used for all internal LLM calls: daemon extraction, reflection,
 * soul synthesis, wakeup briefing, cognitive check. These are
 * background operations, not part of the user-facing prompt chain.
 *
 * NOTE: The engine uses `outputFormat: { type: "json_schema", schema }` for
 * structured output. The Anthropic API doesn't support json_schema natively,
 * so we handle it by appending a JSON instruction to the system prompt.
 * The engine's fallback JSON parsing (regex extraction, trailing comma fix,
 * field-by-field recovery) handles any formatting imperfections.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CompleteFn, CompleteParams, CompleteResult } from "./engine/state.js";
import type { LlmConfig } from "./engine/config.js";
import { log } from "./engine/log.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Create a CompleteFn backed by the Anthropic SDK.
 * Reads ANTHROPIC_API_KEY from environment automatically.
 */
export function createAnthropicComplete(llmConfig: LlmConfig): CompleteFn {
  return async (params: CompleteParams): Promise<CompleteResult> => {
    const model = params.model ?? llmConfig.model;
    const maxTokens = params.maxTokens ?? llmConfig.maxTokens;

    // Handle outputFormat: append JSON instruction to system prompt.
    // The engine's daemon, soul, cognitive check, and skill extraction all
    // request structured JSON output via outputFormat. Since Anthropic's API
    // doesn't have a json_schema mode, we enforce it via prompting.
    let system = params.system ?? "";
    if (params.outputFormat?.type === "json_schema") {
      const schemaHint = JSON.stringify(params.outputFormat.schema);
      system += "\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown fences, no preamble, no explanation. " +
        "Output a single JSON object matching this schema:\n" + schemaHint;
    }

    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: params.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("");

      const thinking = response.content
        .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
        .map(b => b.thinking)
        .join("");

      return {
        text,
        ...(thinking ? { thinking } : {}),
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        model: response.model,
        stopReason: response.stop_reason ?? undefined,
      };
    } catch (err) {
      log.error("Anthropic API call failed:", err);
      throw err;
    }
  };
}
