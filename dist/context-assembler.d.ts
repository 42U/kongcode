/**
 * Context assembler — extracts graph context as a string for Claude Code hooks.
 *
 * Calls the engine's graphTransformContext and extracts the text content
 * from the injected context message + system prompt section. This preserves
 * 100% of the retrieval logic while adapting the output for hook additionalContext.
 */
import type { GlobalPluginState, SessionState } from "./engine/state.js";
/**
 * Run the full context retrieval pipeline and return a formatted string
 * suitable for injection as a Claude Code hook additionalContext.
 *
 * Flow: classifyIntent → vectorSearch → graphExpand → WMR/ACAN scoring
 *       → dedup → budgetTrim → formatContextMessage → extract text
 */
export declare function assembleContextString(state: GlobalPluginState, session: SessionState, userPrompt: string): Promise<string | undefined>;
/**
 * Ingest a user or assistant message into the graph database.
 * Embeds the text and stores it as a turn record with relations.
 */
export declare function ingestTurn(state: GlobalPluginState, session: SessionState, role: "user" | "assistant", text: string): Promise<void>;
