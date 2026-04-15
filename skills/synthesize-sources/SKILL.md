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
