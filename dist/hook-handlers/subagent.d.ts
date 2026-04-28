/**
 * TaskCreated + SubagentStop hook handlers (v1).
 *
 * Subagent tracking lifecycle:
 *   1. PreToolUse(Agent|Task) in pre-tool-use.ts captures the spawn,
 *      writes an initial `subagent` row with outcome="in_progress", and
 *      stashes tool_use_id → subagent_id in session._activeSubagents.
 *   2. SubagentStop (this handler) closes the row with ended_at,
 *      duration_ms, outcome, and optional result_summary.
 *   3. handleTaskCreated currently just logs the raw payload — the
 *      richer data is at PreToolUse so this stays minimal for now.
 *
 * Correlation key preference:
 *   - payload.tool_use_id (if Claude Code propagates it to SubagentStop)
 *   - payload.agent_id (documented per Claude Code hooks reference)
 *   - fallback: most-recent in_progress row for this session
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handleTaskCreated(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
export declare function handleSubagentStop(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
