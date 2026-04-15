---
name: Recall Explain
description: Activate when raw recall results need interpretation — user asks a factual/historical question likely to have graph coverage, and you want clustered, contradiction-flagged, actionable output instead of a flat score-sorted list. Also activate when recall returns 5+ results and you need to decide which matter.
version: 0.1.0
---

# Recall Explain

Wraps raw `recall` output with narrative interpretation: cluster analysis, representative selection, contradiction detection, and application guidance. Turns a score-sorted list into usable evidence.

## When to use

- User asks a factual question answerable from memory ("what did we find about X", "how does Y work in this codebase")
- A recall returns 5+ results and you need to pick which to surface
- You suspect the graph contains conflicting claims (one source contradicts another) and want to expose the contradiction
- You want to see the graph neighborhood around a cluster of results, not just the isolated hits

## Workflow

1. **Call recall with expanded query.** Take user phrasing, add 2-3 synonyms or related terms. Request limit=10 (not default 3) for a richer view.
2. **Read both sections.** After phase 2 arch upgrade, recall returns `GRAPH NEIGHBORS` alongside primary hits. Both matter.
3. **Cluster mentally.** Group results by topic affinity: which hits restate the same idea? Which are distinct angles?
4. **Pick a representative per cluster.** Highest-score or most complete concept. Others confirm the cluster exists but don't need individual citation.
5. **Detect contradictions.** If two clusters disagree on the same question, flag it explicitly. Do not silently pick one and pretend the other doesn't exist.
6. **Produce narrative output.** Structured: cluster summaries → representatives → contradictions → graph neighbors → application to user's question.

## Output format

```
## Memory on <topic>

**Primary findings** (from <N> results across <M> clusters):

- **<Cluster 1 name>**: <1-sentence summary>. Evidence: <concept name> (score <X>).
- **<Cluster 2 name>**: <1-sentence summary>. Evidence: <concept name> (score <X>).

**Graph neighborhood**: <2-3 related concepts from the graph walk>

**Contradictions**: <if any — which clusters disagree and how>

**Application to user's question**: <how these findings answer the specific prompt>
```

## Interaction with ground-on-memory

`ground-on-memory` says "cite what's relevant." `recall-explain` says "here's what relevant looks like when raw output isn't enough." Use recall-explain when ground-on-memory's first-pass scan of injected context finds hints but not enough detail.

## Failure modes

- **Over-clustering**: collapsing distinct results to simplify. Don't. Distinct claims deserve distinct representation.
- **Confirmation bias**: picking representatives that fit your pre-existing answer. Let score + completeness decide.
- **Ignoring graph neighbors**: the GRAPH NEIGHBORS section often surfaces the cross-source links you actually want. Read them.
- **No contradiction flag**: if the graph has two answers, the user deserves to know. Flagging contradictions is a feature.

## Metric this skill drives

Indirectly: `retrieval_utilization` (grounded use of recall output). Directly: qualitative "did Claude ground on multiple sources instead of one" — auditable by reading responses.
