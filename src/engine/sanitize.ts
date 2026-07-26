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
] as const;

const TAG_RE = new RegExp(
  `</?(?:${STRUCTURAL_TAGS.join("|")})\\b[^>]*>`,
  "gi",
);

/** Safety bound on the fixpoint loops. Termination does not depend on it —
 *  every pass that changes the string strictly shortens it, so convergence is
 *  guaranteed in at most len/3 passes. The bound only caps worst-case work on a
 *  pathological input; if it is ever hit, {@link neutralize} makes the leftover
 *  inert rather than shipping it. An earlier version used a bound of 8 and
 *  simply returned, which a 171-character depth-8 payload defeated. */
const MAX_STRIP_PASSES = 64;

/** Last resort when the loop bound is hit: defang every remaining `<` so no
 *  residue can be read as a tag. Deliberately lossy — a mangled payload is
 *  always preferable to a live one. */
function neutralize(text: string): string {
  return text.replace(/</g, "&lt;");
}

/** Remove every occurrence of `re`, repeating until the string stops changing.
 *  A single pass is not enough: deleting an inner tag splices the surrounding
 *  halves into a new, live one —
 *    "<active_dir<active_directives>ectives>" -> "<active_directives>"
 *  and depth-N nesting needs N+1 passes. */
function stripToFixpoint(text: string, re: RegExp): string {
  let out = text;
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const next = out.replace(re, "");
    if (next === out) return out;
    out = next;
  }
  return neutralize(out.replace(re, ""));
}

export function stripStructuralTags(text: string): string {
  // Loop to a fixpoint. A SINGLE pass is defeatable by nesting, because
  // removing the inner tag splices the outer halves into a live one:
  //   "<active_dir<active_directives>ectives>"  --1 pass-->  "<active_directives>"
  // which then renders to the model as a genuine directive block. This used to
  // be masked by a second, whole-string strip at injection time; that pass was
  // removed in v0.8.5 (it was deleting laqrumcode's own section tags), so the
  // content-side strip has to be idempotent on its own.
  return stripToFixpoint(text, TAG_RE).replace(/\n{3,}/g, "\n\n");
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
export function stripReminderWrapper(text: string): string {
  // Also a fixpoint, for the same reason and with sharper stakes: this one
  // guards the envelope itself, so a surviving `</system-reminder>` closes the
  // wrapper early and everything after it lands outside as plain instruction.
  // "</system-remin</system-reminder>der>" defeats a single pass.
  return stripToFixpoint(text, REMINDER_RE).replace(/\n{3,}/g, "\n\n");
}
