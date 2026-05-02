/**
 * Heuristic pre-drain — handle simple pending_work items in-process
 * without spawning a headless Claude subprocess.
 *
 * Targets:
 *   - handoff_note: template from last N turns (no LLM needed)
 *   - reflection (short sessions <3 turns): template summary
 *
 * Returns the number of items processed. The caller can subtract from
 * the queue size to decide whether a full subprocess spawn is still needed.
 */
import type { GlobalPluginState } from "../engine/state.js";
export declare function drainHeuristic(state: GlobalPluginState): Promise<number>;
