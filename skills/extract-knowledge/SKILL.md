---
name: Extract Knowledge (source-agnostic)
description: Activate when the user wants to distill lasting knowledge from ANY source — PDF, web article, pasted text, codebase file, transcript, markdown doc, or book chapter. Source-agnostic replacement for extract-pdf-gems. Same workflow core; source-type-aware quality rules.
version: 0.2.0
supersedes: extract-pdf-gems
---

# Extract Knowledge (source-agnostic)

Source-agnostic generalization of `extract-pdf-gems`. Detects the source type, applies type-specific quality rules, then runs the same extract→backup→write→verify pipeline.

## Supported source types

| Type | Detection | Quality rule addition |
|---|---|---|
| `pdf` | ends in `.pdf`, or pdfinfo succeeds | numerical coefficients required where possible; attribution by author-year |
| `url` | starts with `http(s)://` | page title + retrieval date in source_description; strip nav chrome before extraction |
| `code` | ends in `.ts/.py/.go/.rs/.js/.tsx` | concept names MUST reference actual symbols from the file; line numbers optional but recommended |
| `markdown` | ends in `.md` | preserve doc structure in gem grouping; don't re-extract code blocks as concepts |
| `transcript` | plain text with "[user] / [assistant]" markers | speaker attribution required on each gem |
| `book` | multi-chapter pdf or epub | cross-chapter gems OK; chapter attribution inline |
| `paste` | raw text in the args | source_description must be provided explicitly by user |

## Workflow (identical to extract-pdf-gems core)

1. **Pre-flight**: run `/kongcode-health`, abort if RED.
2. **Detect source type** from path/URL/input.
3. **Read source fully** before drafting gems. Whole-source context shapes which claims are load-bearing.
4. **Draft 20–25 gems** following the base quality rules PLUS the type-specific rule from the table above.
5. **Draft 15–30 cross-links** using the canonical edge vocabulary from `src/engine/edge-vocabulary.ts`.
6. **Write markdown backup** to `${CLAUDE_PROJECT_DIR}/.claude/memory/<slug>-gems.md` with frontmatter + narrative + JSON payload block.
7. **Append MEMORY.md index entry** (one line, under 150 chars).
8. **Call `create_knowledge_gems`** with the payload. Include `provenance: { session_id, source_kind: "gem" }` (phase 3 addition).
9. **Verify via recall** on 2+ semantic queries. Require ≥50% of new gems findable at score >0.5.
10. **Report** with source, gem count, edge count, recall verification, 3-5 sentence substantive summary, and flagged cross-links to pre-existing concepts.

## Base quality rules (unchanged from extract-pdf-gems)

- Self-contained (no "as shown above")
- Numerical where possible
- Source-attributed inline
- ≤350 characters of signal
- No academic hedging
- Options/trading implications tagged with `OPTIONS IMPLICATION:` / `TRADING IMPLICATION:`
- Short snake_case `name` field
- One claim per gem

## Type-specific additions

**PDF** (academic): every gem should either (a) include a specific coefficient/statistic/sample-size, or (b) name a specific methodological choice. "Yang 2025 found AT reduces volatility" is weak; "Yang 2025: AT_volume coefficient β₁=-0.817*** on intraday SD, SZSE panel, 2018–2019" is strong.

**Code** (TypeScript/Python/etc.): every gem must reference a real symbol from the file (function name, class, exported constant). A concept that can't be traced back to code is worthless for debugging later.

**Markdown** (docs): preserve section structure. One top-level section → one gem cluster. Don't merge section 3 and section 7 into one gem unless they're arguing the same point.

**Transcript**: tag gems with speaker role. User-originated gems are ground truth; assistant-originated gems need a confidence marker.

## Canonical edge vocabulary

Use edges from `src/engine/edge-vocabulary.ts`. New edges require discussion — don't invent ad-hoc names. Common choices for extraction:

- `decomposes_into`, `mechanism_for`, `elaborates`, `contextualizes` — structural links within a source
- `contrasts_with`, `tempered_by`, `fails_when` — for tension or boundary conditions
- `derived_from` (automatic — every gem gets this to the source artifact)
- `applies_to_options`, `applies_to_code`, `applies_to_equities` — for cross-domain implications
- `supersedes`, `corrects`, `extends` — for relations to prior concepts

## Cross-source linking

When extracting, run one recall query to see if the source topic has prior coverage. If yes, emit cross-source edges (`extends`, `contrasts_with`, `complemented_by`) to those pre-existing concepts as part of the `links` array. This is where the graph compounds value.

## Failure modes

- **Padding to 25**: don't. Quality over quota.
- **Rewriting the abstract**: abstracts are marketing. Real gems come from the body.
- **Ignoring negative results**: papers sometimes report what didn't work. That's often the highest-leverage gem.
- **Only intra-source links**: fragments the graph. Always cross-link to prior concepts when possible.
- **Stale sandbox on network-mounted files**: if a network mount throws "Stale file handle", copy the source to a local directory first or reconnect the mount.

## Metric this skill drives

`total_concepts` and `total_edges_cross_source`. Each successful extraction should add 20–25 concepts and 20–30 edges (of which 5–10 are cross-source in a graph with prior coverage).
