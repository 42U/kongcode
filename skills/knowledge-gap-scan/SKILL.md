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
