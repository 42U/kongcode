#!/usr/bin/env bash
# Phase 3 — write-time quality

action_apply_concept_provenance() {
  log "apply_concept_provenance: patching src/engine/surreal.ts upsertConcept"
  cd "$REPO"
  local target="src/engine/surreal.ts"
  if grep -q "provenance?: ConceptProvenance" "$target" 2>/dev/null; then
    log "upsertConcept already has provenance param"
    set_task_status phase3.arch_provenance completed "already applied"
    return 0
  fi
  python3 << 'PYEOF'
import pathlib, sys
p = pathlib.Path("src/engine/surreal.ts")
src = p.read_text()

# Add ConceptProvenance type near the top (after imports block).
TYPE_BLOCK = """
/** Phase 3: provenance attached to every concept write so drift audit,
 * supersede-stale, and "where did this come from" debugging are possible. */
export interface ConceptProvenance {
  session_id?: string;
  turn_id?: string;
  skill_name?: string;
  prompt_hash?: string;
  source_kind?: "daemon" | "skill" | "user" | "gem" | "synthesis";
}

"""

if "export interface ConceptProvenance" not in src:
    # Insert after the first blank line following the last top-level import
    idx = src.find("\nconst RECORD_ID_RE")
    if idx == -1:
        print("ERROR: could not find RECORD_ID_RE anchor", file=sys.stderr); sys.exit(2)
    src = src[:idx] + TYPE_BLOCK + src[idx:]

OLD_SIG = r'''async upsertConcept(
    content: string,
    embedding: number[] | null,
    source?: string,
  ): Promise<string> {'''
NEW_SIG = r'''async upsertConcept(
    content: string,
    embedding: number[] | null,
    source?: string,
    provenance?: ConceptProvenance,
  ): Promise<string> {'''
if OLD_SIG not in src:
    print("ERROR: upsertConcept signature not found", file=sys.stderr); sys.exit(2)
src = src.replace(OLD_SIG, NEW_SIG)

# Add provenance to the record object on new concept create path
OLD_RECORD = r'''const emb = embedding?.length ? embedding : undefined;
    const record: Record<string, unknown> = { content, source: source ?? undefined };
    if (emb) record.embedding = emb;
    const created = await this.queryFirst<{ id: string }>(
      `CREATE concept CONTENT $record RETURN id`,
      { record },
    );'''
NEW_RECORD = r'''const emb = embedding?.length ? embedding : undefined;
    const record: Record<string, unknown> = { content, source: source ?? undefined };
    if (emb) record.embedding = emb;
    if (provenance) record.provenance = provenance;
    const created = await this.queryFirst<{ id: string }>(
      `CREATE concept CONTENT $record RETURN id`,
      { record },
    );'''
if OLD_RECORD not in src:
    print("ERROR: concept create record block not found", file=sys.stderr); sys.exit(2)
src = src.replace(OLD_RECORD, NEW_RECORD)

p.write_text(src)
print("surreal.ts upsertConcept patched with provenance")
PYEOF
  set_task_status phase3.arch_provenance completed "optional provenance param + record field"
}

action_apply_edge_vocabulary() {
  log "apply_edge_vocabulary: creating src/engine/edge-vocabulary.ts"
  cd "$REPO"
  local target="src/engine/edge-vocabulary.ts"
  if [ -f "$target" ]; then
    log "edge-vocabulary.ts already exists"
    set_task_status phase3.arch_edge_vocab completed "already present"
    return 0
  fi
  cat > "$target" << 'TSEOF'
/**
 * Canonical edge vocabulary for the kongcode graph.
 *
 * Ad-hoc edge names fragment the graph — two concepts linked by
 * `applies_to_options` and `appliesToOptions` and `options_application`
 * can't easily be found together. This file defines the authoritative set
 * with stable names and brief semantics.
 *
 * Adding a new edge: extend the appropriate category, document the
 * semantics in one line, and update the SKILL.md vocabulary sections.
 * Prefer reusing an existing edge over inventing a new one.
 *
 * Not yet wired into relate() as a hard reject — for now this file is a
 * reference used by skills and documentation. A future phase should add
 * warn-on-unknown in relate() so drift is visible without being disruptive.
 */

export const CANONICAL_EDGES = {
  // ── Structural ─────────────────────────────────────────────────────────
  decomposes_into:  "a whole splits into parts (e.g. total effect → direct + mediated channels)",
  elaborates:       "one concept adds detail to another",
  contextualizes:   "one concept frames another",
  enables:          "a method/tool makes another possible",
  extends:          "builds on a prior concept while preserving its claims",

  // ── Mechanism ──────────────────────────────────────────────────────────
  mechanism_for:        "A is the mechanism through which B happens",
  explained_by:         "A holds because of B",
  prerequisite_for:     "A must be true for B to hold",
  identification_for:   "A is the identification strategy enabling B's causal claim",
  supported_by:         "A is supported by evidence B",
  necessitates:         "A forces B as a consequence",

  // ── Tension ────────────────────────────────────────────────────────────
  contrasts_with:   "A and B are in direct opposition",
  tempered_by:      "A's effect is moderated by B",
  fails_when:       "A stops working when B occurs",
  complemented_by:  "A works alongside B (both needed)",
  corrects:         "A replaces an incorrect claim in B",

  // ── Implication ────────────────────────────────────────────────────────
  implies:              "A implies B as a logical consequence",
  amplifies:            "A strengthens B's effect",
  applies_to_options:   "A has implications for options pricing/trading",
  applies_to_equities:  "A has implications for equity trading",
  applies_to_code:      "A has implications for source code in this project",

  // ── Provenance ────────────────────────────────────────────────────────
  derived_from:   "A was extracted from source B (artifact)",
  cites:          "A references B as a source",
  supersedes:     "A replaces an outdated B in the active knowledge set",
} as const;

export type CanonicalEdge = keyof typeof CANONICAL_EDGES;

export const CANONICAL_EDGE_NAMES: readonly CanonicalEdge[] =
  Object.keys(CANONICAL_EDGES) as CanonicalEdge[];

const _CANONICAL_SET = new Set<string>(CANONICAL_EDGE_NAMES);

/** True if the given edge name is in the canonical vocabulary. */
export function isCanonicalEdge(edge: string): edge is CanonicalEdge {
  return _CANONICAL_SET.has(edge);
}

/** Return the semantic description of a canonical edge, or a placeholder. */
export function describeEdge(edge: string): string {
  return CANONICAL_EDGES[edge as CanonicalEdge] ?? "(non-canonical)";
}
TSEOF
  set_task_status phase3.arch_edge_vocab completed "canonical edge vocabulary file created"
}

action_write_skill_supersede_stale() {
  log "write_skill_supersede_stale: creating skills/supersede-stale/SKILL.md"
  mkdir -p "$REPO/skills/supersede-stale"
  cat > "$REPO/skills/supersede-stale/SKILL.md" << 'SKILLEOF'
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
SKILLEOF
  set_task_status phase3.skill_supersede_stale completed
}

action_write_skill_extract_knowledge() {
  log "write_skill_extract_knowledge: creating skills/extract-knowledge/SKILL.md"
  mkdir -p "$REPO/skills/extract-knowledge"
  cat > "$REPO/skills/extract-knowledge/SKILL.md" << 'SKILLEOF'
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
6. **Write markdown backup** to `/home/zero/.claude/projects/-mnt-money/memory/<slug>-gems.md` with frontmatter + narrative + JSON payload block.
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
- **Stale sandbox on network-mounted files**: if `/mnt/xfer` throws "Stale file handle", copy the source to `/home/zero/voidorigin/` first or reconnect the mount.

## Metric this skill drives

`total_concepts` and `total_edges_cross_source`. Each successful extraction should add 20–25 concepts and 20–30 edges (of which 5–10 are cross-source in a graph with prior coverage).
SKILLEOF
  set_task_status phase3.skill_extract_knowledge completed
}
