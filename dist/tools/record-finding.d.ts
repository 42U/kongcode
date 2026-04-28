/**
 * record_finding MCP tool — structured save for decisions, corrections,
 * preferences, and reusable facts.
 *
 * Wraps commitKnowledge({kind: "memory", ...}) with a validated input
 * shape so bots don't have to remember category naming conventions, the
 * importance scale, or which text to embed. The substrate-does-the-work
 * analog of "teach yourself what to save and how" — the tool signature
 * teaches it by being the only way in.
 *
 * Covers the four most common things a bot wants to permanently remember:
 *   - decision: "we chose X over Y because Z"
 *   - correction: "the user corrected my belief that A — actually B"
 *   - preference: "user prefers workflow/style signal"
 *   - fact: general technical knowledge the bot wants to persist
 *
 * Every write auto-seals about_concept edges via commitKnowledge.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleRecordFinding(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
