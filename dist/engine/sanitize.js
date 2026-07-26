/**
 * Strip laqrumcode structural XML tags from user-supplied text.
 *
 * Prevents stored content from breaking out of its injection envelope
 * when retrieved and assembled into the LLM context. Applied at write
 * time (core_memory, record_finding, commit_work_results) so the graph
 * never contains tag-breakout payloads.
 */
const STRUCTURAL_TAGS = [
    "system-reminder",
    "recalled_memory",
    "active_directives",
    "session_directives",
    "reflection_context",
    "laqrumcode_pending_work",
    "laqrumcode-alert",
    "rules_reminder",
    "persisted-output",
    "user-prompt-submit-hook",
];
const TAG_RE = new RegExp(`</?(?:${STRUCTURAL_TAGS.join("|")})\\b[^>]*>`, "gi");
export function stripStructuralTags(text) {
    return text.replace(TAG_RE, "").replace(/\n{3,}/g, "\n\n");
}
const REMINDER_RE = /<\/?system-reminder\b[^>]*>/gi;
/**
 * Strip ONLY the `<system-reminder>` wrapper, leaving every other structural
 * tag in place.
 *
 * For text laqrumcode assembled itself and is about to wrap. The full
 * {@link stripStructuralTags} is for *content* — anything sourced from a turn,
 * a memory, a tool result — and running it over a finished envelope deletes
 * the envelope: `<active_directives>`, `<session_directives>` and
 * `<recalled_memory>` are all on its list, so the section tags laqrumcode had
 * just written were removed on the way out and the model received tier-0 and
 * tier-1 directives as one unlabelled run of bullets.
 *
 * Breakout is prevented by sanitizing the content going in (see
 * graph-context `formatContextMessage`), not by scrubbing the container.
 * This keeps the one property the wrapper actually needs: no nested
 * `<system-reminder>` from a prior hook or the harness.
 */
export function stripReminderWrapper(text) {
    return text.replace(REMINDER_RE, "").replace(/\n{3,}/g, "\n\n");
}
