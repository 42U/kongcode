#!/usr/bin/env bash
# Phase 4 — compound value skills

action_write_skill_synthesize_sources() {
  log "write_skill_synthesize_sources: creating skills/synthesize-sources/SKILL.md"
  mkdir -p "$REPO/skills/synthesize-sources"
  cat > "$REPO/skills/synthesize-sources/SKILL.md" << 'SKILLEOF'
---
name: Synthesize Sources
description: Activate when the user wants a comparison, contrast, or synthesis across 2+ sources already in the graph. Produces meta-concepts that link back to the original source gems, earning the graph compound value from the cross-source edges.
version: 0.1.0
---

# Synthesize Sources

Takes 2+ source artifacts (already extracted into the graph) and produces meta-concepts that compare, contrast, or synthesize them. Writes the meta-concepts with cross-link edges back to the source gems. This is where the graph stops being a reference library and starts being a reasoning tool.

## When to use

- User asks "how do these papers compare on X?"
- User asks "what's the synthesis of all our research on Y?"
- You notice two sources appear relevant to the same question but nobody's connected them
- You're about to answer a question and the answer is improved by explicitly reasoning across multiple graph entries

## Prerequisites

- At least 2 sources already extracted into the graph (via extract-knowledge or create_knowledge_gems)
- Both sources have embedded concepts — verify with recall first
- The sources have some topic overlap — synthesizing two unrelated papers produces noise

## Workflow

1. **Identify the sources**. Either the user names them, or you run recall on the topic and cluster the results by artifact.
2. **Fetch representative gems** from each source (~5-10 per source) via recall with scope=concepts, limit=10.
3. **Compare systematically**. For each dimension: shared claims, divergent claims, extensions, gaps.
4. **Draft meta-concepts**. Each meta-concept is a single synthesis claim. Examples:
   - "Both Yang 2025 and Brogaard 2014 find HFT captures the best quotes, but Yang finds this is a net stabilizer in Chinese markets while Brogaard shows it's volatility-amplifying in US markets. The difference is the retail-dominance of the underlying investor base."
   - "Every paper in the calculus stack assumes fractional Brownian motion without justification; only temperedFractionalCalculus provides explicit Lévy-process conditions under which the assumption holds."
5. **Cross-link**. Each meta-concept gets edges to its contributing source gems:
   - `extends` — meta-concept builds on source gem
   - `contrasts_with` — meta-concept contrasts two source gems
   - `complemented_by` — meta-concept combines multiple sources
6. **Write via create_knowledge_gems** with source = `synthesis:<src1>+<src2>` and source_type = `synthesis`. Provenance source_kind = `synthesis`.
7. **Verify** via recall on a topic that spans both sources — the meta-concept should surface alongside the source gems.
8. **Report** with: list of meta-concepts, cross-link count, and an explicit "what this lets you do now" paragraph.

## Meta-concept quality rules

Meta-concepts have a HIGHER bar than extraction gems because they claim to represent multiple sources:

- **Grounded in specific source claims**: "Yang finds X (gem: at_reduces_volatility), Brogaard finds Y (gem: hft_volatility_amplifier)". Name the gems.
- **Honest about tension**: don't hide contradictions under smooth transitional prose. "These findings contradict" is better than "these findings complement".
- **Distinct from intra-source claims**: a meta-concept should say something neither source said alone.
- **≤400 characters of signal** (slightly longer allowance than extraction gems because they carry more structure).

## Failure modes

- **Smoothing contradictions**: collapsing real tension into superficial agreement. Readers can tell.
- **Over-generalizing**: a meta-concept that could be anyone's opinion is useless — meta-concepts should make CLAIMS that the graph supports.
- **Missing source gems**: if you can't cite specific contributing gems by name, your synthesis is actually speculation.
- **Circular synthesis**: synthesizing sources you just extracted in the same session. Wait a session — fresh eyes produce better synthesis.

## Metric this skill drives

`total_edges_cross_source` — baseline 0, target 50+ after the first 5 multi-source extractions and 2-3 synthesis passes.
SKILLEOF
  set_task_status phase4.skill_synthesize completed
}

action_write_skill_gap_scan() {
  log "write_skill_gap_scan: creating skills/knowledge-gap-scan/SKILL.md"
  mkdir -p "$REPO/skills/knowledge-gap-scan"
  cat > "$REPO/skills/knowledge-gap-scan/SKILL.md" << 'SKILLEOF'
---
name: Knowledge Gap Scan
description: Activate when the user wants to know what they DO and DON'T know about a topic, before starting research or a project. Turns the graph from a reference library into an active planning tool by reporting coverage and explicit gaps.
version: 0.1.0
---

# Knowledge Gap Scan

Topic-coverage analysis against the graph. Given a topic, identifies what's known, what's implied-but-not-explicit, and what's missing. Use before starting research, project kickoffs, or when the user asks "what do we know about X".

## When to use

- Before starting a new research project on a topic
- Before making a decision that should be grounded in prior work
- User asks "do we have any prior work on X?"
- You're about to extract a new source and want to check for existing coverage (avoid duplication)
- Post-extraction review: did the new gems fill the gaps we expected them to fill?

## Workflow

1. **Accept the topic** as natural language. Don't demand a structured query.
2. **Expand the topic** into 3-5 related sub-queries (synonyms, adjacent concepts, opposite framings).
3. **Run recall on each sub-query** with limit=10, scope=all. Aggregate results into a unified list.
4. **Cluster by sub-topic**. Group hits by semantic affinity.
5. **Classify coverage per cluster**:
   - **Strong**: ≥3 distinct gems with score >0.6, multiple sources, clear consensus
   - **Moderate**: 1-2 gems, single source, or mixed scores
   - **Weak**: only turn mentions, no dedicated concepts
   - **Missing**: no results or results are clearly off-topic
6. **Identify explicit gaps**: sub-topics within the expanded query that returned nothing.
7. **Suggest next actions**:
   - For strong clusters: cite them, don't re-extract
   - For moderate: consider extracting one more source to confirm
   - For weak: suggest promoting turn mentions to concepts via capture-insight
   - For gaps: suggest specific sources the user could ingest
8. **Report** in a coverage-map format (not a document dump).

## Output format

```
## Coverage map: <topic>

**Strong coverage**:
- **<sub-topic 1>**: <N gems> from <M sources>. Representative: "<quote>"
- **<sub-topic 2>**: ...

**Moderate coverage**:
- **<sub-topic 3>**: <N gems>, single source (<source name>). Consider cross-validation.

**Weak coverage**:
- **<sub-topic 4>**: only turn mentions, no dedicated concept. Capture?

**Explicit gaps** (no results):
- <sub-topic 5>
- <sub-topic 6>

**Suggested next moves**:
- <specific actionable item>
- <another one>
```

## When NOT to use

- Topic is trivially specific ("what's the value of PI") — recall is enough.
- You're just looking up one fact — use recall directly.
- The graph is known to be empty on the topic — gap-scan will just confirm that, wasting the call.

## Interaction with other skills

- After gap-scan finds weak coverage → propose `extract-knowledge` on a specific source
- After gap-scan finds contradictions → fire `recall-explain` for a deeper dive into the conflict
- After gap-scan finds strong coverage → `ground-on-memory` can confidently cite without re-checking

## Failure modes

- **Query too narrow**: miss adjacent content. Always expand before scanning.
- **Query too broad**: everything matches weakly. Narrow after the first pass.
- **Confusing weak coverage with gaps**: weak means "mentioned but not formalized"; gap means "absent". Different actions.
- **Skipping the expand step**: single-query scans miss 60% of relevant content because the graph is phrased in the source's vocabulary, not yours.

## Metric this skill drives

No direct metric — gap-scan is planning support, not a write operation. Success is measured by whether the user's next decision is better informed.
SKILLEOF
  set_task_status phase4.skill_gap_scan completed
}

action_write_skill_audit_drift() {
  log "write_skill_audit_drift: creating skills/audit-drift/SKILL.md"
  mkdir -p "$REPO/skills/audit-drift"
  cat > "$REPO/skills/audit-drift/SKILL.md" << 'SKILLEOF'
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
SKILLEOF
  set_task_status phase4.skill_audit_drift completed
}
