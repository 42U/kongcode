/**
 * Deferred Cleanup — queue work for orphaned sessions.
 *
 * When the process dies abruptly (Ctrl+C×2, terminal X-button, WSL pause),
 * SessionEnd never fires. On every SessionStart, this module finds orphaned
 * sessions (started but never marked cleanup_completed), queues the same
 * pending_work items SessionEnd would have queued, and marks them ended.
 *
 * No LLM calls — all intelligence runs through Claude subagents via pending_work.
 */
import type { SurrealStore } from "./surreal.js";
export declare function runDeferredCleanup(store: SurrealStore): Promise<number>;
