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
