# Soul Graduation System

## Gates (8 total: 7 volume + 1 quality — ALL must be met)

| # | Threshold | Description |
|---|-----------|-------------|
| 1 | 15+ sessions | Completed sessions |
| 2 | 10+ reflections | Metacognitive lessons stored (active only) |
| 3 | 5+ causal chains | Cause-effect patterns traced |
| 4 | 30+ concepts | Semantic knowledge nodes |
| 5 | 30+ skills | Learned procedures |
| 6 | 5+ monologues | Thinking traces captured |
| 7 | 3+ days elapsed | Time since first session |
| 8 | quality >= 0.85 | Composite quality gate (below) |

## Quality Gate (composite >= 0.85)

| Signal | Weight | Description |
|--------|--------|-------------|
| Retrieval utilization | 30% | Are retrieved items actually used? |
| Skill success rate | 25% | Do learned procedures work? |
| Reflection severity (inverted) | 25% | Fewer critical reflections = better |
| Tool failure rate (inverted) | 20% | Fewer failures = better |

Under 10 quality data points the composite is penalized proportionally, so a
low-activity agent with clean stats cannot graduate prematurely.

## Maturity Stages (gates met out of 8)

- **nascent** (0-4/8) — Too early, build experience
- **developing** (5/8) — Some signal, diagnose weak areas
- **emerging** (6/8) — Volume there, quality is blocker
- **maturing** (7/8) — Almost ready
- **ready** (8/8) — GRADUATED

## Soul Document

After graduation, the soul is a singleton record (`soul:laqrumbrain`) containing:
- `working_style[]` — How the agent approaches problems (max 20)
- `emotional_dimensions[]` — `{dimension, description, adopted_at}` (max 10)
- `self_observations[]` — What it noticed about itself (max 20)
- `earned_values[]` — `{value, grounded_in}`, values grounded in evidence (max 10)
- `revisions[]` — Audit trail of identity evolution (capped at 50, oldest trimmed)

The soul is seeded as Tier 0 core memory (loaded every turn), and re-seeded
after every landed evolution so revisions reach the runtime context.

## Post-Graduation Evolution

Session end enqueues a `soul_evolve` pending-work item (when a soul exists;
`soul_generate` otherwise). The drain agent receives the current soul plus new
reflections/causal chains/monologues since `updated_at`, and returns ONLY the
sections that changed — each included section REPLACES the stored one, so it
must be the complete revised array. The commit handler defends the data:
delta-shaped returns (zero overlap with the stored section) are appended
rather than allowed to wipe the section, writes are value-CAS-guarded against
concurrent evolutions, and per-section caps bound growth (append overflow ages
out the oldest entries, logged).
