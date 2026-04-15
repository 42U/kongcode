#!/usr/bin/env bash
# Phase 2 action implementations — sourced by exec.sh

action_apply_recall_graph_neighborhoods() {
  log "apply_recall_graph_neighborhoods: patching src/engine/tools/recall.ts"
  cd "$REPO"
  local target="src/engine/tools/recall.ts"
  if grep -q "GRAPH NEIGHBORS" "$target" 2>/dev/null; then
    log "recall.ts already patched (idempotent skip)"
    set_task_status phase2.arch_recall_edges completed "already applied"
    return 0
  fi
  python3 << 'PYEOF'
import pathlib, sys
p = pathlib.Path("src/engine/tools/recall.ts")
src = p.read_text()

OLD = r'''const all = [...results, ...neighbors]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, maxResults);'''

NEW = r'''// Phase 2: keep neighbors separate so output surfaces graph-walk neighborhood
        // distinctly from primary vector hits. Gives grounding skills a clearer
        // signal about which items are direct matches vs. cross-linked context.
        const primary = [...results]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, maxResults);
        const primaryIds = new Set(primary.map(r => r.id));
        const neighborList = neighbors.filter(n => !primaryIds.has(n.id)).slice(0, 5);
        const all = primary;'''

if OLD not in src:
    print("ERROR: primary slice block not found in recall.ts", file=sys.stderr)
    sys.exit(2)
src = src.replace(OLD, NEW)

OLD2 = r'''return {
          content: [{ type: "text" as const, text: `Found ${all.length} results for "${params.query}":\n\n${formatted}` }],
          details: { count: all.length, ids: all.map((r) => r.id) },
        };'''

NEW2 = r'''const neighborBlock = neighborList.length > 0
          ? "\n\n=== GRAPH NEIGHBORS (" + neighborList.length + ") ===\n" +
            neighborList.map((n, i) => {
              const tag = `[${n.table}]`;
              const score = n.score ? ` score:${n.score.toFixed(2)}` : "";
              return `${i + 1}. ${tag}${score}\n   ${(n.text ?? "").slice(0, 200)}`;
            }).join("\n\n")
          : "";

        return {
          content: [{ type: "text" as const, text: `Found ${all.length} results for "${params.query}":\n\n${formatted}${neighborBlock}` }],
          details: { count: all.length, ids: all.map((r) => r.id), neighbor_count: neighborList.length },
        };'''

if OLD2 not in src:
    print("ERROR: return block not found in recall.ts", file=sys.stderr)
    sys.exit(2)
src = src.replace(OLD2, NEW2)

p.write_text(src)
print("recall.ts patched")
PYEOF
  set_task_status phase2.arch_recall_edges completed "primary/neighbors split + GRAPH NEIGHBORS section"
}

action_apply_retrieval_reason_field() {
  log "apply_retrieval_reason_field: patching src/context-assembler.ts"
  cd "$REPO"
  local target="src/context-assembler.ts"
  if grep -q "RETRIEVAL RATIONALE" "$target" 2>/dev/null; then
    log "context-assembler.ts already patched (idempotent skip)"
    set_task_status phase2.arch_retrieval_reason completed "already applied"
    return 0
  fi
  python3 << 'PYEOF'
import pathlib, sys
p = pathlib.Path("src/context-assembler.ts")
src = p.read_text()

OLD = r'''if (parts.length === 0) return undefined;

    // Store retrieval summary for planning gate
    session.lastRetrievalSummary = `${result.stats.graphNodes} graph nodes, ${result.stats.neighborNodes} neighbors`;
    session.lastQueryVec = null; // Will be set by the retrieval pipeline internally

    log.debug(`Context assembled: ${result.stats.graphNodes} nodes, ${result.stats.mode} mode`);

    return parts.join("\n\n");'''

NEW = r'''if (parts.length === 0) return undefined;

    // Store retrieval summary for planning gate
    session.lastRetrievalSummary = `${result.stats.graphNodes} graph nodes, ${result.stats.neighborNodes} neighbors`;
    session.lastQueryVec = null; // Will be set by the retrieval pipeline internally

    log.debug(`Context assembled: ${result.stats.graphNodes} nodes, ${result.stats.mode} mode`);

    // Phase 2: prepend a RETRIEVAL RATIONALE preamble so Claude can see WHY
    // this context was retrieved, not just WHAT was retrieved. Keywords echoed
    // from the prompt make relevance explicit rather than implicit, moving
    // grounding from inference to reading.
    const STOP = new Set(["this","that","with","from","have","been","what","when","where","your","their","about","which","would","could","should","will","the","and","for","are","was","were"]);
    const keywords = userPrompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP.has(w))
      .slice(0, 6);
    const rationale = "=== RETRIEVAL RATIONALE ===\n" +
      `Retrieved ${result.stats.graphNodes} graph nodes + ${result.stats.neighborNodes} neighbors ` +
      `based on prompt keywords: ${keywords.length > 0 ? keywords.join(", ") : "(general)"}.` +
      (result.stats.mode ? ` Mode: ${result.stats.mode}.` : "") +
      "\nScan items below; items matching your user's intent should be grounded in your reply.";

    return [rationale, ...parts].join("\n\n");'''

if OLD not in src:
    print("ERROR: target block not found in context-assembler.ts", file=sys.stderr)
    sys.exit(2)
src = src.replace(OLD, NEW)
p.write_text(src)
print("context-assembler.ts patched")
PYEOF
  set_task_status phase2.arch_retrieval_reason completed "RETRIEVAL RATIONALE preamble added"
}

action_write_skill_recall_explain() {
  log "write_skill_recall_explain: creating skills/recall-explain/SKILL.md"
  mkdir -p "$REPO/skills/recall-explain"
  cat > "$REPO/skills/recall-explain/SKILL.md" << 'SKILLEOF'
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
SKILLEOF
  set_task_status phase2.skill_recall_explain completed
}

action_write_skill_capture_insight() {
  log "write_skill_capture_insight: creating skills/capture-insight/SKILL.md"
  mkdir -p "$REPO/skills/capture-insight"
  cat > "$REPO/skills/capture-insight/SKILL.md" << 'SKILLEOF'
---
name: Capture Insight
description: Activate when an insight worth keeping emerges mid-session — a surprising finding, a reusable pattern, a user correction, or a decision with rationale. Use this to write knowledge into the kongcode graph immediately rather than waiting for end-of-session daemon extraction (which is batch-only and can have hours of lag).
version: 0.1.0
---

# Capture Insight

Mid-session foreground knowledge capture. When you (or the user) produce something worth keeping, this skill writes it to the graph RIGHT NOW so future recall can find it — without waiting for the session-extraction daemon.

## Why it exists

Before phase 2, knowledge from the current session was invisible to your own later turns. The session-end extraction daemon processed transcripts into concepts, but that ran hours after the fact and was broken for a long time. The graph was a lagging indicator of current-session reasoning.

capture-insight fixes that for specific high-value insights. Not every observation — only ones that deserve to persist across sessions.

## When to use

- **Surprising finding**: "AT actually REDUCES volatility in emerging markets — opposite of developed-market literature."
- **Correction**: "My earlier claim about X was wrong. Real answer is Y because Z."
- **Reusable pattern**: "This debug sequence (check X → isolate Y → apply Z) worked every time for this bug class."
- **Decision with rationale**: "We picked Postgres over SurrealDB for the billing service because [reasons]."
- **User-provided ground truth**: User says "the reason we do it this way is X" — almost always worth capturing.

## When NOT to use

- Ephemeral session state ("I'm editing foo.ts right now") — not memory-worthy.
- Trivial observations ("this function has 50 lines") — no lasting value.
- Things the daemon would catch anyway (raw session content gets extracted eventually).
- Unconfirmed insights — capture AFTER user validation, not before.

## Workflow

1. **Draft the insight as a single gem** following gem quality rules: standalone, specific, ≤350 chars, source-attributed.
2. **Classify type**: concept / correction / skill / monologue.
3. **For concept type** (most common): call `create_knowledge_gems` with source = `session:<session_id>`, source_type = `session`, and a 1-element gems array.
4. **Cross-link to recent context**: if the insight relates to recent recall results, add edges to those concept ids using `elaborates`, `contrasts_with`, or `corrects`.
5. **Verify via recall roundtrip**: issue recall on a keyword from the content, confirm it surfaces at score >0.5.
6. **Tell the user what you captured** so they can veto if you captured something that shouldn't persist.

## Gem quality gate for mid-session capture

Mid-session captures need a HIGHER bar than batch extraction because they lack editing benefit. Each captured gem must:

- Be confirmed true (not a guess, not in-progress hypothesis)
- Have clear source attribution (which paper / user statement / file)
- Be actionable or factual, not commentary
- Not duplicate an existing concept (quick recall check first)

If any fail, don't capture. Note the insight in conversation and let the daemon handle it.

## Interaction with supersede-stale

If capture-insight writes a concept that contradicts an existing one, immediately call `supersede-stale` on the old. Otherwise recall returns both and creates the appearance of contradiction when it's actually just stale data.

## Failure modes

- **Capturing too much** — turning every interesting sentence into a gem. Graph floods with noise. Prune ruthlessly.
- **Capturing before confirmation** — writing "X is true" when user said "X might be true". Require confirmation.
- **Forgetting cross-links** — a gem with no edges is a silo. Always link to at least one related concept.
- **Silent writes** — not telling the user. Erodes trust. Always confirm what you captured.

## Metric this skill drives

`mid_session_writes_ratio` — baseline 0, target 0.30 (30% of session-produced insights captured in-session rather than batch). Higher is generally better but noise-sensitive.
SKILLEOF
  set_task_status phase2.skill_capture_insight completed
}
