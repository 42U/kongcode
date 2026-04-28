/**
 * Claude Code transcript reader.
 *
 * Stop hook needs the assistant's response text to evaluate retrieval
 * utilization (text overlap with retrieved items). The Stop payload itself
 * doesn't carry the response — only `transcript_path` to the JSONL file
 * Claude Code writes turn by turn. This module pulls the latest assistant
 * text from that file.
 *
 * Why this exists: previously the Stop hook read `session.lastAssistantText`,
 * but nothing in the production hook chain ever set that field — the
 * llm-output engine handler that populates it is test-only, never wired.
 * As a result, `evaluateRetrieval` always early-returned (no turn id, no
 * response text) and `retrieval_outcome` writes silently stopped on
 * Apr 15. This reader closes that loop.
 */
/**
 * Read the latest assistant message text from a Claude Code transcript.
 *
 * Reads only the file's tail (256 KB) for performance. Returns "" if
 * the file is missing, unreadable, or contains no assistant message
 * with text content.
 */
export declare function readLatestAssistantText(transcriptPath: string): string;
/**
 * Read per-turn token usage from the transcript.
 *
 * Returns aggregate `{ inputTokens, outputTokens }` for the most-recent
 * assistant turn:
 *   - `inputTokens` is the LATEST assistant message's usage.input_tokens
 *     plus its cache_read + cache_creation tokens. Cumulative-by-position
 *     in Anthropic's API; the latest message reflects the full turn input.
 *   - `outputTokens` is the SUM of output_tokens across all assistant
 *     messages in the current turn (possibly multiple if tool use happened).
 *
 * "Current turn" = assistant messages after the most recent user message
 * whose content isn't purely tool_result blocks.
 *
 * Returns null if no usage data is found. Powers postflight()'s
 * orchestrator_metrics fields actual_tokens_in / actual_tokens_out, which
 * had been stuck at 0 because nothing populated session._pendingInputTokens
 * in production (the engine-side llm-output handler that sets it is
 * test-only, same dead-code shape as the v0.4.2 fixes).
 */
export declare function readTurnTokenUsage(transcriptPath: string): {
    inputTokens: number;
    outputTokens: number;
} | null;
