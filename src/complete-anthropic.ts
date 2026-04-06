/**
 * Anthropic SDK implementation of the CompleteFn interface.
 *
 * Used for all internal LLM calls: daemon extraction, reflection,
 * soul synthesis, wakeup briefing, cognitive check. These are
 * background operations, not part of the user-facing prompt chain.
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

    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        ...(params.system ? { system: params.system } : {}),
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
