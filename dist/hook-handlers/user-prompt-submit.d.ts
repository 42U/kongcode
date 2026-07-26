/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as additionalContext.
 *
 * On the first turn of a new session, also checks for pending background
 * work and instructs Claude to spawn a subagent to process it.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
/** Wrap raw laqrumcode context in a system-reminder block. Claude Code's harness
 * gives system-reminder blocks higher attention weight than plain injected
 * text — empirically the plain-text injection was hitting ~10% retrieval
 * utilization because the model read it as ambient noise.
 *
 * 0.7.44: legend rewritten to align with Anthropic's documented prompt-
 * engineering guidance for Claude 4.5+:
 *  - "MUST" and "authoritative" softened — Anthropic explicitly warns these
 *    overtrigger on 4.5+ models.
 *  - Motivation-first: instruction frames the WHY (let the model decide
 *    relevance) rather than commanding compliance.
 *  - Quote-first grounding: ask for explicit reference-by-id when grounding,
 *    matching Anthropic's documented `<quotes>`-then-answer pattern.
 *
 * This is stage 2 of the v0.7.43-45 injection rework. Stages 3+ will move
 * the body itself to XML semantic tags and intent-gate the directive load. */
/** @internal Exported for test — the section tags it must NOT eat are the
 *  whole point of the injection format. */
export declare function wrapMemoryContext(raw: string | undefined | null): string;
export declare function handleUserPromptSubmit(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
