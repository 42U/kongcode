/**
 * Lightweight error swallowing with severity levels.
 *
 * - swallow(ctx, e)       — SILENT: expected degradation (embeddings offline, non-critical telemetry).
 *                           Only visible with KONGCODE_DEBUG=1.
 * - swallow.warn(ctx, e)  — WARN: unexpected but recoverable (DB query failure, compaction failure).
 *                           Always logged to stderr.
 * - swallow.error(ctx, e) — ERROR: something is genuinely broken (cleanup failure, schema failure).
 *                           Always logged to stderr with stack trace.
 */
/**
 * Swallow an error silently. Only visible with KONGCODE_DEBUG=1.
 * Use for expected degradation (embeddings down, non-critical graph edges).
 */
declare function swallow(context: string, err?: unknown): void;
declare namespace swallow {
    var warn: (context: string, err?: unknown) => void;
    var error: (context: string, err?: unknown) => void;
}
export { swallow };
