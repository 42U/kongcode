---
name: Extract PDF Knowledge Gems
description: Activate when the user asks to extract, mine, distill, or "pull gems" from a PDF, academic paper, book chapter, or research document into the kongcode memory graph. Also activate for phrases like "read this paper and remember it", "dense knowledge gems", "pull the insights", or when the user points at a PDF and asks to study it.
version: 0.1.0
---

# Extract PDF Knowledge Gems

Distills a source document into ~20–25 standalone, searchable concept records in the kongcode graph, with cross-link edges, a source artifact, and a durable markdown backup. Use this skill whenever the user wants lasting knowledge from a document — not just a one-time summary.

## Preconditions — run `/kongcode-health` first

Before writing anything, verify the kongcode pipeline is healthy. If `kongcode-health` reports RED, abort and tell the user what's broken. A partial write with a broken embedding pipeline or broken recall corrupts the graph and wastes the extraction work.

Also verify the PDF is accessible. If it lives on `/mnt/xfer` and your bash reports "Stale file handle", run `/xfer-reconnect` first or ask the user to `cp` the file into `/home/zero/voidorigin/` where it'll be readable from a clean path.

## Workflow

1. **Locate the PDF and check its page count.** Use `pdfinfo` or the file size as a rough guide. Read PDFs over 10 pages with the `pages` parameter (max 20 pages per Read call) and chunk if longer than 20.

2. **Read the PDF fully** before drafting any gems. Resist the urge to extract as you read — whole-document context shapes which claims are load-bearing and which are scaffolding.

3. **Draft 20–25 gems** following the quality rules below. Fewer is fine if the paper is thin; more is fine if it's dense. Do not pad to hit 25.

4. **Draft 15–30 cross-link edges** between gems using the standard edge vocabulary below. Links are where the graph earns its keep — they let future recall walk from one concept into the neighborhood of related ones.

5. **Write the markdown backup** to `/home/zero/.claude/projects/-mnt-money/memory/<slug>-gems.md`. Include YAML frontmatter, a narrative section with all gems, and a JSON payload block that can be replayed into `create_knowledge_gems` verbatim. Backup is the source of truth — if the graph write fails partially, the backup lets us replay.

6. **Append an index entry** to `/home/zero/.claude/projects/-mnt-money/memory/MEMORY.md` — one line, under 150 chars, format: `- [<title>](<file>.md) — <hook>`.

7. **Call `create_knowledge_gems`** with the payload. Verify the response shows `success: true`, `concepts_skipped: 0`, `edges_skipped: 0`. If any were skipped, the skill has failed — investigate the skipped items in the return value.

8. **Verify via `recall`** with at least two semantic queries pulled from the gem content. Require at least half the new gems to surface on semantic search. If recall returns nothing relevant, the embeddings didn't complete — flag for the user, don't pretend it worked.

9. **Report to the user** with: source identifier, gem count, edge count, recall verification result, 3–5 sentence substantive summary of what the paper actually said, and any cross-links to pre-existing concepts the recall surfaced.

## Gem quality rules

A gem is a **standalone concept**. Someone reading it in isolation six months from now — with no access to the PDF — should get a dense, usable insight.

- **Self-contained**: no "as shown above", "see Figure 3", "the authors argue". State the claim directly.
- **Numerical where possible**: coefficients, p-values, percentages, sample sizes. `β₁=-0.817***` is stronger than "significantly negative".
- **Source-attributed**: name the author-year (`Yang et al. 2025`) or mechanism name (`Serial Multiple Mediation`) inline so the gem is traceable.
- **≤350 characters of signal**: tight prose. Strip hedges ("it seems that", "arguably"). Past that length, split into two gems or cut scaffolding.
- **No academic hedging**: state findings at their actual confidence level, don't soften them. If the paper says p<0.01, say it, don't say "some evidence suggests".
- **Options/trading implications tagged**: if a gem has a concrete trading implication, lead with `OPTIONS IMPLICATION:` or `TRADING IMPLICATION:` in the content. These get special cross-link edges (`applies_to_options`) that surface during strategy discussions.
- **Short `name` field, snake_case**: the name is the cross-link handle, not the content. `at_reduces_volatility`, not `"Algorithmic trading reduces volatility"`. Names must be unique within the gems list.
- **One claim per gem**: if a sentence has two insights, split it. Compound gems break cross-linking.

## Cross-link edge vocabulary (canonical)

Always use edges from this list. New edges require discussion before adding to the vocabulary — ad-hoc edges fragment the graph.

**Structural:**
- `decomposes_into` — a whole splits into parts (e.g., total effect → direct + mediated channels)
- `elaborates` — one concept adds detail to another
- `contextualizes` — one concept frames another
- `enables` — a method/tool makes another possible

**Mechanism:**
- `mechanism_for` — A is the mechanism through which B happens
- `explained_by` — A holds because of B
- `prerequisite_for` — A must be true for B to hold
- `identification_for` — A is the identification strategy enabling B's causal claim
- `supported_by` — A is supported by evidence B
- `necessitates` — A forces B as a consequence

**Tension:**
- `contrasts_with` — A and B are in direct opposition
- `tempered_by` — A's effect is moderated by B
- `fails_when` — A stops working when B occurs
- `complemented_by` — A works alongside B (both needed)

**Implication:**
- `implies` — A implies B as a logical consequence
- `amplifies` — A strengthens B's effect
- `applies_to_options` — A has implications for options pricing/trading
- `applies_to_equities` — A has implications for equity trading

## File conventions

- **Backup markdown path**: `/home/zero/.claude/projects/-mnt-money/memory/<slug>-gems.md`
- **Slug rule**: short identifier for the source, no spaces, lowercase, e.g. `impact-algo`, `poly-calculus`, `algo-trading-cs2`.
- **Frontmatter fields**: `name`, `description`, `type: reference`, `source`, optionally `source_doi`.
- **Payload JSON block**: ready-to-call `create_knowledge_gems` invocation. Include `source`, `source_type`, `source_description`, `gems`, `links`. Must be valid JSON — no comments, no trailing commas.

## Failure modes to watch for

- **"I'll extract 25 gems"** then producing 25 superficial ones just to hit the count. Quality over quota.
- **Cross-linking only within one source**. Where possible, use recall to find pre-existing concepts and link to them with `elaborates` or `contrasts_with`. Cross-source links are where the graph compounds value.
- **Rewriting the abstract** as gems. The abstract is a marketing document. Real gems come from the body text — specific coefficients, failure modes, methodology quirks, counter-intuitive findings.
- **Ignoring negative results** in the paper. If the authors tried something and it didn't work, that's a gem — name it explicitly.
- **Sandbox reading a stale `/mnt/xfer`** and not noticing. If the Read tool returns unexpected content, verify the mount with `grep xfer /proc/mounts` and `ls /mnt/xfer/`.

## What success looks like

- `create_knowledge_gems` returns `success: true`, `concepts_created` matches gem count, `edges_created` matches link count, zero skipped.
- A follow-up `recall` query pulls at least half the new gems on a semantic query.
- The graph shows the new gems clustering in embedding space near any pre-existing related concepts (visible in recall results ordering).
- The markdown backup and MEMORY.md index entry are written. Future sessions can find the backup via the index without rerunning the skill.
