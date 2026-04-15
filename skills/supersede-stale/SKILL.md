---
name: Supersede Stale Knowledge
description: Activate when a recalled or injected concept is contradicted by current code, a newer source, or a user correction. Use this to demote stale knowledge in realtime rather than letting the batch daemon eventually catch it — stale concepts compete with fresh ones in recall and poison grounding.
version: 0.1.0
---

# Supersede Stale Knowledge

Real-time supersession of outdated concepts. When you detect that a graph item is wrong, this skill writes a correction memory, links it via a `supersedes` edge, and decays the stale concept's stability so future recall deprioritizes it.

## Why it exists

The supersession pipeline in kongcode (`src/engine/supersedes.ts`) only fires from batch daemon extraction of user corrections. That means stale knowledge sits active in the graph between extraction runs — which can be hours or, historically, forever if the pipeline was broken. Recall returns stale and fresh concepts side by side, creating false contradictions and eroding grounding confidence.

This skill exposes supersession as a foreground operation you can invoke the moment you detect drift.

## When to use

- **Code drift**: a concept describes a file/symbol/function that has since been renamed or removed. Verify the drift (read current code), then supersede the old concept.
- **Factual correction**: a newer source contradicts an older one, AND the newer source is more reliable (recent paper vs older paper, authoritative doc vs blog post, user statement vs inferred claim).
- **User correction**: user says "no, actually it works like X" — capture-insight writes the new, this skill supersedes the old.
- **Contradiction between concepts from same source**: a paper's conclusion contradicts its abstract. Supersede the abstract claim.

## When NOT to use

- The "stale" concept might still be true in a narrower context — don't supersede, add a `contextualizes` edge instead.
- You're uncertain which of two contradicting concepts is correct — surface the contradiction to the user first (via recall-explain), then ask which to keep.
- The concept is from a different source you haven't vetted — superseding based on one new source can be over-eager.

## Workflow

1. **Verify the drift.** Read the current source of truth (code file, latest paper, user statement). Confirm the stale concept is actually wrong, not just incomplete.
2. **Write the correction as a memory record.** Use capture-insight with classification=correction. Content: brief description of what's wrong and what's right.
3. **Fire the supersedes edge.** Call `create_knowledge_gems` with a single link: `{from: correction_id, to: stale_concept_id, edge: "supersedes"}`.
4. **Decay stability**: the backend supersession pipeline (`src/engine/supersedes.ts`) handles stability decay when it sees the `supersedes` edge. Phase 3 bug fixes in session-start.ts mean this pipeline now actually runs without silently failing.
5. **Verify**: recall on the topic. The corrected concept should rank above the stale one (or the stale one should be filtered entirely).
6. **Tell the user** what you superseded and why. Supersession without notification is a trust hazard.

## Caveats

- **Irreversibility is not absolute**: stability decay is a multiplicative factor, not deletion. The stale concept still exists — it just ranks lower in recall. If you're wrong about the drift, a later correction can restore it.
- **Supersession chains**: if concept A superseded concept B, and concept C supersedes A, the graph now shows both edges. Don't supersede A again for the same reason.
- **Don't auto-supersede from vector similarity alone**: two concepts may be semantically similar but express distinct claims. Human judgment (or at least a user confirmation) gates the action.

## Interaction with capture-insight

`capture-insight` writes the new. `supersede-stale` removes the old. Both should fire together when you make a correction, not independently. Capture without supersede leaves the graph holding both old and new. Supersede without capture just deletes knowledge.

## Metric this skill drives

`total_supersede_edges` (new metric — track in plan.json). Baseline 0. Target: any non-zero count after phase 3 is deployed, with the ratio of capture/supersede events approaching 1:1 for user-corrected content.

## Canonical edge

This skill uses the `supersedes` edge from `src/engine/edge-vocabulary.ts`. Edge semantics: "A replaces an outdated B in the active knowledge set."
