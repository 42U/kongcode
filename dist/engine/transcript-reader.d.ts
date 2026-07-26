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
/**
 * Derive a Claude Code transcript path from a session id and working directory.
 *
 * Fallback for hook payloads that don't carry `transcript_path`. Claude Code
 * stores transcripts at `~/.claude/projects/<cwd-with-separators-as-dashes>/
 * <session-id>.jsonl` — e.g. cwd `/home/u/proj` becomes `-home-u-proj`.
 *
 * Only usable because v0.8.5 unified the session-id spaces: `session.sessionId`
 * is now Claude Code's own session UUID (see mcp-client resolveSessionId), which
 * is exactly the transcript filename. Before that the tool path carried
 * `mcp-client-<pid>` and this derivation would have pointed at nothing.
 */
export declare function deriveTranscriptPath(sessionId: string, cwd: string, home: string): string;
/**
 * How many assistant tool calls have been recorded since the model last produced
 * visible text (or since the last real user turn).
 *
 * This is the signal the planning gate in hook-handlers/pre-tool-use.ts needs and
 * has never had. `session.toolCallsSinceLastText` was incremented but never reset,
 * because the only code that zeroed it (engine/hooks/llm-output.ts) is test-only
 * and Claude Code's hook surface has no assistant-text event. Deriving the count
 * from the transcript sidesteps that entirely — and is stateless, so it stays
 * correct across daemon restarts, relay reconnects and session-map eviction.
 *
 * Two structural facts about Claude Code transcripts make this work, both
 * verified against a live file rather than assumed:
 *
 *  1. Each content block is its own JSONL entry. A turn appears as a run of
 *     separate `assistant` entries — `text`, then `thinking`, then `tool_use`,
 *     … — not one message with a mixed content array. So "did the model narrate
 *     before this tool call" is answerable by scanning entries in order.
 *  2. The assistant entry carrying a `tool_use` is flushed to disk BEFORE the
 *     tool runs, so a PreToolUse hook sees the text that preceded it.
 *
 * `thinking` blocks deliberately do NOT reset the count: thinking happens just
 * as much inside a loop, and the gate exists to notice silence toward the user.
 *
 * A `user` entry resets the count, but only when it is a real user turn —
 * tool_result blocks come back as `user`-typed entries, and treating those as
 * user input would reset on every single tool call and disable the gate.
 *
 * Returns 0 when the transcript is missing or unreadable, which fails OPEN: the
 * gate simply never fires rather than firing spuriously.
 */
export declare function countToolCallsSinceText(transcriptPath: string, minTextChars?: number): number;
