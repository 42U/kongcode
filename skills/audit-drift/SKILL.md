---
name: Audit Drift
description: Activate periodically (not per-session) to sample concepts from the graph and verify their claims against current state — code paths, recent sources, user-provided ground truth. Flag stale concepts for supersede-stale. Without this, knowledge rot poisons retrieval silently.
version: 0.1.0
---

# Audit Drift

Periodic sweep for stale knowledge. Samples concepts, verifies them against current state, and flags drift for `supersede-stale`. This is the counterweight to extraction: extraction adds, audit removes.

## When to use

- Once a week (or after every ~50 new concept writes, whichever first)
- Before a high-stakes grounding task where you want to trust recall completely
- After a major refactor or codebase migration (code-referencing concepts may have rotted)
- When `ground-on-memory` detects that a cited concept is suspiciously out of step with current state

## When NOT to use

- Every session — audit-drift is heavyweight, runs many verification steps
- Right after extraction — the newest concepts are the least likely to have drifted
- When the graph is known-fresh — wait until real use has accumulated

## Workflow

1. **Sample concepts**. Pick N=20 by a mix of criteria:
   - 5 highest-importance concepts
   - 5 most-recently-accessed concepts
   - 5 oldest concepts (time-based drift risk)
   - 5 concepts containing file paths / version numbers / specific code symbols
2. **For each sampled concept, classify drift risk**:
   - **Code-reference**: mentions a file path, function name, class, or symbol. Verify the file still exists and the symbol is still there.
   - **Version-reference**: mentions a version number or dated API. Verify the version is still current.
   - **Factual**: a standalone claim with no project-state dependency. Verify by fresh recall on the topic — if a contradicting newer concept exists, drift is real.
   - **Source-attributed**: claims from a specific paper. Lower drift risk unless the paper itself has been superseded in the graph.
3. **Verify each concept**. Be conservative — only flag drift on strong evidence.
4. **Categorize findings**:
   - **Confirmed drift**: strong evidence the concept is wrong now → fire `supersede-stale`
   - **Possibly stale**: weak evidence → flag for user review, don't auto-supersede
   - **Clean**: still accurate → no action
   - **Ambiguous**: can't determine → skip, re-audit next cycle
5. **Report** with: sample size, drift rate (% flagged), categorized findings, and which concepts got auto-superseded vs user-review.
6. **Update metric**: `drift_rate_per_audit` in plan.json.

## Conservative rules for flagging drift

- **File missing** alone is NOT drift. File may have moved. Check for symbol via grep before flagging.
- **Symbol renamed** IS drift. Supersede.
- **Symbol refactored** (same name, different semantics) IS drift. Supersede.
- **Version number outdated** depends — sometimes version-specific info is still historically valid. Flag but don't auto-supersede.
- **Factual contradiction from newer source**: supersede only if the newer source is from a clearly more authoritative artifact (e.g., a later paper by the same authors, user correction over inferred claim).

## Failure modes

- **Too aggressive**: flagging concepts as stale when they're actually fine in a narrower context. Use `contextualizes` edges instead of supersession when unsure.
- **Too conservative**: never flagging anything. Audit-drift then produces no value. Balance requires judgment.
- **Wrong sample**: only sampling by age. Miss newer-but-drifted concepts. Stratified sample across criteria is non-negotiable.
- **No user visibility**: silent auto-supersession erodes trust. Always report what was flagged even when auto-action was taken.

## Interaction with other skills

- `supersede-stale` handles the actual demotion once drift is confirmed
- `recall-explain` can be called to investigate ambiguous findings
- `capture-insight` may fire when you discover a new ground-truth claim during audit

## Metric this skill drives

`drift_rate_per_audit` — % of sampled concepts flagged as stale. Target: 5-15% in a healthy graph. >20% means either extraction is producing noisy concepts or the graph has been neglected. <3% means audit isn't catching drift that's actually there.
