/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */
import type { GlobalPluginState } from "./engine/state.js";
/** Hook response format matching Claude Code's expected output.
 *
 * IMPORTANT: `additionalContext` must be inside `hookSpecificOutput` with a
 * matching `hookEventName` — Claude Code's Zod schema silently strips
 * unknown top-level keys. Top-level fields are only: continue,
 * suppressOutput, decision, reason, stopReason, systemMessage, hookSpecificOutput.
 */
export interface HookResponse {
    continue?: boolean;
    suppressOutput?: boolean;
    /** Warning shown in UI — NOT sent to the model. */
    systemMessage?: string;
    stopReason?: string;
    hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
        [key: string]: unknown;
    };
    /** For Stop hooks: approve or block the stop. */
    decision?: "approve" | "block";
    reason?: string;
}
/** Helper: wrap additionalContext in the hookSpecificOutput envelope Claude Code expects. */
export declare function makeHookOutput(eventName: string, additionalContext?: string, extra?: Record<string, unknown>): HookResponse;
type HookHandler = (state: GlobalPluginState, payload: Record<string, unknown>) => Promise<HookResponse>;
/** Register a hook handler for an event. */
export declare function registerHookHandler(event: string, handler: HookHandler): void;
/**
 * Remove `.kongcode-<pid>.sock` files in `dir` whose PID is no longer alive.
 * Skips ownPid and any PID that exists but we can't signal (EPERM).
 *
 * Also reaps live sibling MCPs by sending SIGTERM to their PIDs (default on).
 * The hook proxy routes to whichever per-PID socket has the newest mtime, so
 * older MCPs become unreachable after a Claude Code restart and just sit
 * holding memory until killed manually. Reaping closes that loop.
 *
 * Set `KONGCODE_KEEP_SIBLINGS=1` to opt out — required when running multiple
 * Claude Code windows simultaneously, since each window has its own MCP and
 * killing siblings would orphan the others. Single-window users (the common
 * case) want default-on behavior so no zombies linger.
 */
export declare function sweepStaleSockets(dir: string, ownPid: number): void;
/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export declare function startHttpApi(state: GlobalPluginState, sock?: string, projectDir?: string): Promise<void>;
/** Stop the internal HTTP API and clean up socket/port files. */
export declare function stopHttpApi(): Promise<void>;
export {};
