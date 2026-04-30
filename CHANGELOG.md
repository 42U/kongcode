# Changelog

All notable changes to KongCode are documented here. The 0.7.x series introduced the daemon-split architecture; 0.8.0 will be the first marketplace-ready stable.

## [Unreleased]

### Added
- README rewrite covering daemon arch, multi-session, auto-drain costs, env-var matrix, and troubleshooting (`README.md`)
- This CHANGELOG file

## [0.7.33] — 2026-04-30

### Fixed (production-readiness sweep — 3 silent gaps)

A user-driven audit of "what's still unwired" surfaced 3 issues. All low-blast-radius, all single-spot fixes, all addressed in this release.

#### `subagent.task` schema strictness — same shape as the v0.7.23 `mode` fix
Hook handlers (pre-tool-use) create `subagent` rows before the task description is known, but `task` was strict `TYPE string` (schema.surql:337). Daemon log was flooding with `Couldn't coerce value for field 'task' of 'subagent:...': Expected 'string' but found 'NONE'` per spawn. Relaxed to `option<string>` via `DEFINE FIELD OVERWRITE`, matching the v0.7.23 mode-field treatment. Live DBs converge on next daemon restart.

#### `citation_method='lexical'` fallback for paraphrased items
The v0.7.27 audit signal only set `cited=true` on `[#N]` matches. Items the model genuinely used but paraphrased (rephrasing the content without an explicit citation) got `cited=false, citation_method='none'` — incorrect audit credit. Added a lexical fallback: when no `[#N]` matched but `signals.utilization >= 0.5` (heavy keyTerm + trigram overlap, the existing computeSignals path), set `cited=true, citation_method='lexical'`. Threshold picks up genuine paraphrase without rewarding incidental word reuse.

#### `orphan_concepts` query false positives
The v0.7.23 silent-failure detector was flagging hundreds of `ingest:turn`-source concepts as "orphans" per active session. These are per-turn extractions whose provenance is the source turn — already linked via the existing `mentions` edge (turn→concept), NOT via `derived_from`. The query now filters `WHERE source != 'ingest:turn'` so it fires only for actual missing-edge bugs in gem/causal extraction (the original v0.7.23 use case).

### Tests
- Existing 4 citation-grounding cases still pass.
- New 5th case pins lexical-fallback behavior (paraphrase without `[#N]` → `cited=true, citation_method='lexical'`).
- 593 tests pass (was 592 + 1).

### Notes
- The 4 stale-purged `pending_work` items the alert flagged are pre-X-close-pattern orphans (sessions that purged before `session-end` ran). Forward path is clean — auto-drain threshold was already lowered from `>= 5` to `>= 1` in an earlier release.
- ~270 unbackfilled memories + ~40 reflections continue to reference orphan session_ids that don't resolve to any session row even via kc_session_id. Documented as data-quality residue, not a code gap.

## [0.7.32] — 2026-04-30

### Fixed (graduation-pipeline parser hardening + observability)

A v0.7.31 memory-extractor subagent run today submitted a `causal_graduate` work item with 6 skill candidates. The handler returned `skills_created: 0` and only 1 skill landed in the recent timeline (and that 1 came through a different code path — the per-session `memory-daemon.ts:343` extractor — not the subagent's explicit submission). 5 of 6 high-quality skill candidates were silently dropped.

Phase-1 root-cause analysis confirmed the parser contract was well-aligned with the documented instructions, but `parseCausalGraduationResult` (pending-work.ts:638) had **3 silent-failure paths** that returned `[]` without any log line:
1. Wrapped object shape (`{skills: [...]}`, `{result: [...]}`, etc.) → "not-an-array" path
2. Single skill object instead of a batch → "not-an-array" path
3. JSON parse failure on a string → "json-parse-failed" path

And `parseSkillResult` had additional drop paths: missing `name`, `steps` not an array, `steps` empty.

**Two-part fix:**

**Part 1 — drop-reason telemetry (`tracedrop`).** Every silent-failure return now emits a `log.warn`-level line tagged `[graduation-parser]` with the specific reason and a 300-char preview of the offending payload. So the next time a batch silently drops, the daemon log carries actionable evidence — not just `skills_created: 0`.

**Part 2 — tolerant parsing (`coerceSkill`).** New shared helper that accepts:
- **Name aliases**: `name` → `title` → `skill_name` → `id`. Subagents emit varied shapes; rejecting on an alias mismatch is over-strict.
- **String-array `steps` coercion**: each string becomes `{tool: "unknown", description: str}`. Better to land the row with an imperfect step shape than drop it entirely — the downstream skill-render path already handles the canonical shape and an unwritten skill is unrecoverable.
- **Step-field aliases**: each step can have `{name|tool, text|description|desc}`.

`parseCausalGraduationResult` now also unwraps top-level wrapper keys (`skills`, `result`, `extracted`, `items`, `data`) and treats a single `{name, steps}` object as a single-element array.

The downstream `ExtractedSkill` interface and `createSkillRecord` are unchanged — the contract on the *output side* is still strict; the parser becomes more forgiving on the *input side*.

### Tests
- New `test/pending-work-parser.test.ts` — 13 cases pinning canonical shape (regression), 5 wrapper unwraps, single-object handling, name-alias acceptance, step-coercion, step-field-alias coercion, and 4 truly-invalid drops.
- 592 tests pass (was 579 + 13).

## [0.7.31] — 2026-04-30

### Added (Reflexion-style grounding nudge — context-grounding plan phase 4)

Phase 2 (v0.7.27) wired the citation audit (`retrieval_outcome.cited` populated each turn from `[#N]` regex parsing) and added the helper `getLastTurnGroundingTrace` in `retrieval-quality.ts` — but the helper had no caller. The audit signal flowed to the DB and stopped there. Self-RAG/Reflexion (research from gap 3 synthesis) is to surface this trace back into the model as next-turn behavioral feedback. Without it, `cited` is dashboard-only and doesn't shape model behavior. This release closes the loop.

**Implementation:**
- `state.ts:85` — new `lastReflexionFireTurn: number = -1` on `SessionState` for cooldown tracking.
- `graph-context.ts:739-762` — at the start of the BEHAVIORAL DIRECTIVES rendering block, calls `getLastTurnGroundingTrace(session.sessionId, store)` and applies fire conditions. If firing, prepends a single-line nudge as its own section above BEHAVIORAL DIRECTIVES and updates `session.lastReflexionFireTurn`. swallow.warn-wrapped — the audit-loop code path is non-critical and must not break context injection.

**Fire conditions (all must hold):**
1. Last turn had retrieval (`injected >= 3`).
2. Zero structural citations (`cited === 0`).
3. At least 3 high-salience items were ignored (`ignored_high_salience.length >= 3`, where high-salience = retrieval_score ≥ 0.6).
4. Cooldown: didn't fire on the immediately preceding turn (`session.userTurnCount > session.lastReflexionFireTurn + 1`).

**Inject format:**
```
GROUNDING NUDGE (prior turn): N load-bearing items injected, 0 cited.
Either ground on them this turn (use [#N] indices) or explicitly note
why they're inapplicable. Repeated ignore-without-explanation degrades
retrieval utility scores.
```

**Why not a new CognitiveDirective type:** the `CognitiveDirective` union (`repeat | continuation | contradiction | noise | insight`) is for the LLM-graded cognitive-check pipeline. This nudge is mechanical — derived from `cited` field counts, not LLM judgment. Inject directly into the directive section text rather than extend the type union.

### Tests
- New `test/reflexion-nudge.test.ts` — 9 cases across 2 describe blocks pinning the trace contract (4) and fire-condition gates (5: volume threshold, engagement signal, cooldown, null-trace).
- 579 tests pass (was 570 + 9).

### Plan complete
With phases 1–4 shipped (v0.7.26–28 + v0.7.31), the four context-grounding gaps from the 2026-04-30 plan are closed end-to-end:
1. **Project-scoped retrieval** (v0.7.26 + 0.7.29 + 0.7.30 follow-ups for backfill robustness)
2. **Citation pattern via [#N]** (v0.7.27)
3. **Reranker-calibrated salience bands** (v0.7.28)
4. **Reflexion-style grounding feedback loop** (v0.7.31)

Remaining deferred polish (out of scope for this release train, but tracked):
- WMR-distribution-derived bands when reranker is offline (cosmetic — only matters if the reranker model dies).
- `citation_method='lexical'` for paraphrased items the model didn't cite by `[#N]` (audit-only enrichment; current code only sets `cited=true` on `[#N]` matches).

## [0.7.30] — 2026-04-30

### Fixed
- **`backfill_project_id` join key.** The migration's session-traversal subquery used `WHERE id = $parent.session_id` — but `memory.session_id`, `reflection.session_id`, and `skill.session_id` store the **kc_session_id** string (uuid-shaped, e.g. `0df34328-...`), not the surreal record ref (`session:abc123`). Result: the v0.7.29 backfill caught only 218/778 memories (28%) and 0/52 reflections (the kc-id pattern dominant) and had to rely on the small subset of rows that happened to store the surreal ref. Fixed to `WHERE kc_session_id = $parent.session_id OR id = $parent.session_id` — matches both shapes so legacy data with either populates correctly. Re-running on a v0.7.29-backfilled DB will now catch the remaining ~560 memories + 52 reflections.

## [0.7.29] — 2026-04-30

### Fixed (in-memory→DB-row write gap class — 0.7.28 follow-up)

After 0.7.28 shipped, running `backfill_project_id` revealed memories backfilled 0/778 because the traversal `memory.session_id → session.project_id` returned NONE for every session — sessions persist `agent_id` and `kc_session_id` to the DB but **not** `project_id`. That's a `SessionState`-populated-but-not-written gap; the user prompted to audit the rest of the codebase for the same class. Found 5 more sites with the same shape. Fixed all 6 in one pass.

**Row writers updated:**
- `surreal.ts:createSession` — accepts `projectId`, writes `project_id` field.
- `surreal.ts:ensureSessionRow` — accepts `projectId`, **also backfills the field on existing rows** where it's NONE (so resumed-conversation rows get the field on next UserPromptSubmit).
- `surreal.ts:createTask` — accepts `projectId`, writes `project_id` field. The `task_part_of` edge stays as the canonical link; this is the denormalized field for fast filter.
- `pending-work.ts:374` (reflection write) — adds `project_id` from `item.project_id`. Reflection writes are session-keyed and `pending_work` already carries `project_id` per row.
- `pending-work.ts:678` (`createSkillRecord`) — adds `project_id`.
- `pending-work.ts:445` (handoff_note memory) — adds **both** `session_id` and `project_id` (was: only the synthetic `source: "session:..."` string, unsearchable).
- `memory-daemon.ts:343` (skill direct write) — adds `project_id`.

**Hook callers threaded:**
- `session-start.ts:47, 53` — passes `session.projectId` to createTask + createSession.
- `user-prompt-submit.ts:75` — passes `session.projectId` to ensureSessionRow.

**Migration extended:**
`introspect.action=migrate, filter=backfill_project_id` now backfills 6 tables (was 2 in 0.7.26). Order matters: tasks → sessions (via task→project edge chain) → concepts (via relevant_to) → memories (via session.project_id) → reflections → skills (via skill_from_task→task or session_id fallback). Re-running on a 0.7.26-backfilled DB will catch the rows the original migration couldn't reach.

### Why this matters
The 0.7.26 read-side filter is soft (`project_id IS NONE` allowed), so this gap caused no runtime regression — pre-migration rows still surface across projects. But the *benefit* of project scoping was muted: only 1274/2534 concepts (~50%) got scoped, and 0/778 memories. After this release + a re-run of `backfill_project_id`, project scoping should approach 100% coverage on legacy data.

### Tests
- `test/project-scoped-retrieval.test.ts` updated: idempotency case now uses `toMatchObject` against the extended 6-table details shape.
- 570 tests pass (no new tests — the surface is migration-shaped and covered by the existing project-scoped-retrieval cases plus the live backfill run).

## [0.7.28] — 2026-04-30

### Changed (reranker-calibrated salience bands — context-grounding plan phase 3)

The pre-0.7.28 `(relevance: N%)` was the blended WMR/ACAN/cross score rendered as a percentage. Per GroGU (arxiv 2601.23129), raw retriever scores are weakly predictive of LLM grounding utility — and the percentage gave a false sense of precision. The cross-encoder (bge-reranker-v2-m3) is sigmoid-calibrated in [0,1], and >0.7 is a reliable threshold. Replacing the percentage with **three coarse bands** gives the model a stable anchor that survives embedder swaps and per-query distribution variance.

**Bands (from cross-encoder score):**
- `[load-bearing]` — score ≥ 0.7. Directive: must ground on these or explicitly note why not.
- `[supporting]` — score 0.3–0.7. Directive: mention if directly applicable.
- untagged (background) — score < 0.3. Directive: skip unless directly relevant; do not pad responses with these.
- **dropped** — score < 0.15. Hard noise filter — the cross-encoder strongly disagreeing with the WMR upstream is signal that the item is irrelevant despite its embedding similarity.

**Implementation:**
- `graph-context.ts:rerankResults` — preserves raw `crossScore` and stamps `band` on each candidate (was: discarded after blend). Drops candidates below `BAND_DROP_BELOW`. Tail items (ranked 31+, never reached the cross-encoder) default to `band='background'`.
- `graph-context.ts:bandFor` (new export) + `BAND_LOAD_BEARING_MIN`/`BAND_SUPPORTING_MIN`/`BAND_DROP_BELOW` constants.
- `graph-context.ts:744-810` — TOP HITS and per-section listings render `[band]` tag instead of `(relevance: N%)` whenever the cross-encoder fired. Falls back to the percentage for legacy/no-rerank paths so the output stays self-explanatory if the reranker model is missing.
- `user-prompt-submit.ts:38-50` — directive rewritten to explain bands and what action each warrants.

**Why band > percentage:** the percentage is a blend that mixes WMR (vector + ACAN) with cross-encoder; calibration is opaque to the reader. The band reflects only the cross-encoder calibrated probability, which has stable semantics. The user (or future-Claude) reading "(relevance: 67%)" cannot tell whether 67% is high or low for this query; reading "[supporting]" carries the answer.

### Tests
- New `test/salience-bands.test.ts` — 4 cases pinning the band thresholds and constant coherence.
- 570 tests pass (was 566 + 4).

### Plan complete
With phases 1 (project scope) + 2 (citation + grounding trace) + 3 (salience bands) shipped, the three context-grounding gaps the plan named on 2026-04-30 are all closed. Out of scope and tracked for follow-up:
- Reflexion-style "last turn you ignored 3 high-salience items" inject (`getLastTurnGroundingTrace` is wired in 0.7.27; the cognitive-check directive emission path is the missing piece).
- WMR-distribution-derived bands when the reranker isn't loaded (currently falls back to the percentage; could fall back to top-quartile/middle/bottom bands for consistent UX).
- `citation_method='lexical'` for paraphrased items.

## [0.7.27] — 2026-04-30

### Added (citation pattern + grounding-trace observability — context-grounding plan phase 2)

The pre-0.7.27 directive *"Cite items by their concept id when citing"* required emitting opaque ids like `concept:iw9rd1zsai2y2wmlqv2a` — useless to humans, so the model either ignored the directive (no audit signal) or followed it and produced unreadable output. The grounding-trace observability gap was that `retrieval_outcome` (36k+ rows) tracked **lexical** overlap as a proxy for whether items were used, but had no **structural** citation signal — so dashboards couldn't distinguish "model used this and rephrased it" from "model ignored it but happened to mention a similar word."

Adopting the Anthropic-Citations-API / Perplexity numbered-marker pattern: items are now rendered with `[#N]` prefixes (e.g. `[#3] [concept] (relevance: 67%) ...`); the directive tells the model to cite by `[#N]`; the substrate parses `[#N]` regex out of the response at Stop time and writes `cited: true` to the matching retrieval_outcome row.

**Implementation:**
- `user-prompt-submit.ts:38-42` — directive updated: *"Items are numbered [#N] — cite by index (e.g. [#3]) when grounding on them; the substrate maps the index back to the source."*
- `graph-context.ts:744-810` — builds `idToIndex: Map<string, number>` from the dedup+sort by finalScore. Same `[#N]` is used in TOP HITS and per-section listings (one stable handle per item across both views).
- `graph-context.ts:stageRetrieval` call — passes a `Map<number, string>` (1-based index → memory_id) alongside the items, so Stop has the lookup table at evaluation time.
- `retrieval-quality.ts:stageRetrieval` — accepts optional `indexMap` parameter; persists alongside items on the per-turn `_pendingRetrieval` state.
- `retrieval-quality.ts:evaluateRetrieval` — runs `responseText.matchAll(/\[#(\d+)\]/g)`, maps indices back via `indexMap`, writes `cited: bool` and `citation_method: 'index' | 'none'` to each `retrieval_outcome` row when an indexMap was provided.
- `retrieval-quality.ts:getLastTurnGroundingTrace` — new helper. Returns `{ injected, cited, ignored_high_salience }` from the last turn's retrieval_outcome rows. Foundation for the upcoming Reflexion-style "you ignored item X" feedback loop (deferred to 0.7.27.x).

**Schema:** SCHEMALESS so no DEFINE FIELD changes; `cited` and `citation_method` start appearing on rows after this release ships.

### Tests
- New `test/citation-grounding.test.ts` — 4 cases pinning the citation parser: hits + misses + idempotency on duplicate citations + back-compat for legacy callers without indexMap.
- 566 tests pass (was 562 + 4).

### Out of scope (deferred to 0.7.27.x or 0.7.28)
- Reflexion-style "last turn you ignored 3 high-salience items" injection in BEHAVIORAL DIRECTIVES — `getLastTurnGroundingTrace` is wired but the cognitive-check inject path is a separate change.
- Lexical-fallback `citation_method='lexical'` for items the model paraphrased without [#N] — the existing `utilization` lexical signal stays separate; only [#N] sets `cited=true` for now.

## [0.7.26] — 2026-04-30

### Fixed (cross-project bleed — context-grounding plan phase 1)

Retrieval was global by default — `vectorSearch` and `retrieveReflections` had **zero project-scoped WHERE clauses**, so `<reflection_context>` and recall blocks routinely injected lessons from unrelated projects (finance/trading, WhatsApp tooling, heartbeat polls) into kongcode-engineering turns. ICLR 2025 ("Long-Context LLMs Meet RAG") confirms cross-domain hard negatives hurt accuracy more than no retrieval at all. The substrate already had project pillars (`session.projectId` populated at session-start, `relevant_to`/`used_in` edges) — the retriever just wasn't honoring them.

**Read path:**
- `surreal.ts:vectorSearch` — accepts optional `projectId`; soft filter `(project_id IS NONE OR project_id = $pid OR scope = 'global')` applied to concept, memory, artifact subqueries. NONE-on-row preserves pre-migration data.
- `reflection.ts:retrieveReflections` — accepts `projectId`; filters by `session_id IN (SELECT id FROM session WHERE project_id = $pid)` traversal on top of direct project_id/scope match.
- `graph-context.ts:1261, 1347` — pipes `session.projectId` into both calls.
- `prefetch.ts:prefetchContext` — accepts `projectId`; piped through to vectorSearch + retrieveReflections.
- `context-engine.ts:301` — passes `session.projectId` to prefetchContext.

**Write path (denormalize project_id field):**
- `surreal.ts:upsertConcept/createMemory/createArtifact` — accept `projectId`, write `project_id` field on CREATE. Concept upsert path also backfills the field on re-touch when missing.
- `commit.ts:CommitConceptData/MemoryData/ArtifactData` — `projectId?: string` added to all three; piped to store.
- `concept-extract.ts:133` — passes `opts.projectId` to commitKnowledge.
- `memory-daemon.ts` — 5 sites updated (3× createMemory + 1× createArtifact + 1× upsertConcept) pass `projectId`.

**Backfill:**
- New `introspect.action=migrate, filter=backfill_project_id` sub-mode. Concepts: derives from outgoing `->relevant_to->project` edge. Memories: traverses `memory.session_id → session.project_id`. Idempotent — only touches rows where `project_id IS NONE`.

**Soft-launch semantics:** the WHERE filter accepts `project_id IS NONE` so pre-migration rows still surface (no regression). Once `backfill_project_id` runs, NONE rows are limited to truly unscoped data (bootstrap directives intended as global). A future release can tighten the filter once `scope='global'` tagging is mature.

### Tests
- New `test/project-scoped-retrieval.test.ts` — 4 cases pinning the backfill migration: concept-edge backfill, memory-session-traversal backfill, idempotency, broken-edge tolerance.
- 562 tests pass (was 558 + 4).

## [0.7.25] — 2026-04-30

### Fixed
- **Phantom failed MCP server entry in `/mcp`.** `.mcp.json` lived at the repo root, where Claude Code's project-level MCP auto-discovery picked it up *in addition to* the plugin loader. The project-context spawn failed because `${CLAUDE_PLUGIN_ROOT}` only resolves inside plugin context — node got the literal string and threw `ENOENT`. Plugin-context loading still worked (which is why MCP tool calls succeeded), but `/mcp` showed a phantom failed entry every session and Claude Code attempted a doomed second spawn. Moved `.mcp.json` → `.claude-plugin/mcp.json` so only the plugin manifest sees it. Updated `plugin.json` `mcpServers` ref accordingly. Removed redundant `.mcp.json` entry from `package.json` `files` list (the new path is included via the existing `.claude-plugin/` entry).

## [0.7.24] — 2026-04-30

### Added
- **`backfill_derived_from` migrate sub-mode.** Repairs concepts orphaned by the pre-0.7.23 `derived_from` schema mismatch. Selects concepts where `string::starts_with(source, 'gem:')` AND `array::len(->derived_from->?) = 0`, strips the `gem:` prefix to derive the artifact path, and re-RELATEs `concept→derived_from→artifact`. Idempotent — the orphan filter excludes already-linked concepts. Invoke via `introspect.action=migrate, filter=backfill_derived_from`. Verified live: 63 orphans repaired on the maintainer's DB, 0 missing artifacts, 0 RELATE failures.

### Fixed
- **`orphan_concepts` query template — two SurrealQL bugs surfaced during backfill testing.** SQL `LIKE` is not a SurrealQL keyword (replaced with `string::starts_with()`), and `string::starts_with()` errors on `NONE` values (added `source IS NOT NONE` guard). Both fixed in the same path the backfill uses.

## [0.7.23] — 2026-04-30

### Fixed
- **`derived_from` schema mismatch.** Schema declared `IN concept OUT task`, but two real callers wrote `concept → artifact` (gem provenance from `create_knowledge_gems`) and `subagent → task` (parent linking from `pre-tool-use`). Every invocation flooded `daemon.log` with `Couldn't coerce value for field out` errors and dropped the provenance edge — concepts got created, but tracing them back to their source returned nothing. Widened to `IN concept|subagent OUT task|artifact` via `DEFINE TABLE OVERWRITE` so live DBs converge on next daemon start.
- **Missing `spawned_from` edge.** `pre-tool-use` writes `subagent → spawned_from → session` for parent-session provenance, but the relation was never declared. Added `IN subagent OUT session`; added to `VALID_EDGES` whitelist in `surreal.ts`.
- **`subagent.mode` rejected NONE.** Hook handlers create subagent rows before they know the mode (`full | incognito`), but the field was a strict `TYPE string`. Relaxed to `TYPE option<string>` via `OVERWRITE`.
- **`orchestrator_metrics_daily.p95_tokens_in` array-of-NONE.** `math::percentile()` returned the input column instead of a scalar when input was all-NONE. Added a defensive `asFloat()` coercion before write.

### Changed (silent-failures sweep)
- Promoted high-severity `.catch(() => {})` and DEBUG-level `swallow()` calls to `swallow.warn` (always logged) on graph-integrity edges that, when they fail, leave concepts orphaned from their provenance:
  - `pending-work.ts:384` — `reflects_on` (reflection → session)
  - `pending-work.ts:680` — `skill_from_task` (skill → task)
  - `concept-links.ts:89-98` — `narrower` / `broader`
  - `concept-links.ts:119-122` — `related_to`
  - `commit.ts:150-154` — source → concept

### Added
- **`schema-edge-integrity` regression test** (`test/schema-edge-integrity.test.ts`) — parses `schema.surql` for every `RELATION` definition and statically checks every `store.relate(<from>, "<edge>", <to>)` call site against the schema's allowed IN/OUT types. Catches future bugs of the 0.7.22 class at PR time.
- **`orphan_concepts` introspect query** — concepts older than 1h with no outgoing `derived_from` edge. Runtime visibility into provenance gaps so the next regression of this class shows up in `kongcode-status` instead of being silently absorbed.

### Notes
- Test suite: 555 tests pass (was 548). New schema-edge-integrity contributes 3.
- Existing daemons running pre-0.7.23 schema will converge on next restart — `OVERWRITE` runs every boot via `runSchema()` and is idempotent.

## [0.7.15] — 2026-04-29

### Fixed
- `backfillSessionTurnCounts` SurrealQL parse error: was constructing `UPDATE <uuid>` statements with raw `turn.session_id` values (Claude Code session UUIDs). Now looks up by `kc_session_id` field. Eliminates the noisy "Cannot perform subtraction with 'e74702b0' and 'eb6b'" entries from `daemon.log`.

## [0.7.14] — 2026-04-29

### Added
- **Auto-drain scheduler restored.** Daemon now spawns `claude --agent kongcode:memory-extractor -p ...` as a headless subprocess when the `pending_work` queue exceeds threshold. Restores the auto-extraction behavior that lived in the in-process MemoryDaemon before commit `4f7b962` removed the Anthropic SDK.
- New env vars: `KONGCODE_AUTO_DRAIN`, `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5), `KONGCODE_AUTO_DRAIN_INTERVAL_MS` (default 300000), `KONGCODE_CLAUDE_BIN`
- New `src/daemon/auto-drain.ts` with PID-file-locked scheduler
- SessionEnd hook triggers an immediate debounced drain check

## [0.7.13] — 2026-04-29

### Changed
- Default idle reap timeout: 60s → 6s. Anything longer was just holding ~150MB of BGE-M3 in RAM for nobody. Configurable via `KONGCODE_DAEMON_IDLE_TIMEOUT_MS`.

## [0.7.12] — 2026-04-29

### Added
- One-time historical backfill: `backfillSessionTurnCounts` runs in `runBootstrapMaintenance` and reconciles `session.turn_count = 0` rows by counting their linked `turn` rows.

### Changed
- `turn_count` increments now happen on UserPromptSubmit (reliable hook, fires at turn start), not Stop (fragile). Token accounting still happens in Stop.
- Split `store.updateSessionStats` into `bumpSessionTurn` and `addSessionTokens`. The combined version is `@deprecated` and kept as a backward-compat shim.

## [0.7.11] — 2026-04-29

### Added
- `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` env var (default 60s) to tune the idle reaper introduced in 0.7.10.

## [0.7.10] — 2026-04-29

### Added
- **Idle reaper.** Daemon exits after `idleTimeoutMs` of zero attached clients. Restores the implicit "die when nobody's home" behavior from the pre-0.7.0 monolith model.
- `meta.health.stats` now includes `idleSince` and `idleTimeoutMs` for observability.

## [0.7.9] — 2026-04-29

### Added
- **Per-socket client identity registry.** `DaemonServer.clients` is now `Map<Socket, ClientInfo>` instead of `Set<Socket>`. New `meta.handshake` request shape accepts `{clientInfo: {pid, version, sessionId}}`; daemon logs connect/disconnect lines with full identity.
- `meta.health.stats.clients` returns the array of identified clients

## [0.7.8] — 2026-04-29

### Added
- **Orphan-recycle fallback.** When a 0.7.8+ mcp-client connects to a pre-0.7.7 daemon and `meta.requestSupersede` returns `-32601 Method not found`, the client falls back to checking `meta.health.activeClients`. If we're the only attached client (orphan), it sends `meta.shutdown` and re-spawns. Closes the bootstrap gap on the upgrade boundary from older daemons.

## [0.7.7] — 2026-04-29

### Added
- **Supersede protocol.** New `meta.requestSupersede` RPC. A newer mcp-client flags the running daemon for graceful exit when its last attached client disconnects. Older sibling sessions keep working until they naturally close. Multi-session-safe code refresh.

### Changed
- `DaemonServer.checkSupersedeReady` fires `onSupersedeReady` callback exactly once per supersede cycle.

## [0.7.6] — 2026-04-29

**Reverted in 0.7.7.** Initial version-mismatch logic killed the daemon on any mismatch; correctly flagged by user as wrong (would disrupt sibling sessions). Replaced with the supersede protocol.

## [0.7.5] — 2026-04-29

### Fixed
- `session.turn_count` stuck at 0: Stop hook now calls `updateSessionStats` to increment per-turn. Previously only PreCompact fired the increment, which is rare.
- `sessionEnd:endSession: Invalid record ID format:` log noise: guarded `endSession` call on truthy `surrealSessionId`.

## [0.7.4] — 2026-04-29

### Fixed
- **ESM `require()` bug in spawn-lock cleanup.** `package.json` is `"type": "module"` so `require("node:fs").unlinkSync(...)` threw ReferenceError silently swallowed by `try/catch`. Three call sites in `mcp-client/daemon-spawn.ts` and one in `daemon/index.ts` patched to use the imported `unlinkSync`/`mkdirSync` directly. Stale `daemon.spawn.lock` files now actually get cleaned up.
- **Lazy session-row backfill on `claude --resume`.** Claude Code doesn't refire SessionStart on resumed conversations, so resumed sessions had no DB row, leaving turns ingested but unattributable. UserPromptSubmit now calls `store.ensureSessionRow(kcSessionId, agentId)` (idempotent) when `session.surrealSessionId` is unset. Closes the X-close orphan pattern forward.

## [0.7.3] — 2026-04-29

### Fixed
- Stale `daemon.spawn.lock` recovery: `tryAcquireSpawnLock` now reads the holder PID, unlinks the file if dead, and retries the lock acquire. Self-heals stale locks from prior daemon attempts that exited without clean release.

## [0.7.2] — 2026-04-29

### Fixed
- **Eager daemon spawn from mcp-client startup.** Hooks fire BEFORE any tool call, so the lazy "spawn daemon on first tool call" path missed every hook in a session that didn't invoke MCP tools. mcp-client now triggers `getOrConnectIpc()` in the background after the MCP stdio handshake completes. In-flight promise cache prevents lock-contention races between the eager call and any concurrent tool-call.

## [0.7.1] — 2026-04-29

### Added
- Daemon now exposes the legacy HTTP API on a per-PID Unix socket (`~/.kongcode-<pid>.sock`) so `hook-proxy.cjs` can find it. Without this, hooks silently no-op'd in the daemon-arch path.
- `.mcp.json` flipped from `node dist/mcp-server.js` (legacy monolith) to `node dist/mcp-client/index.js` (daemon-arch thin client).

## [0.7.0] — 2026-04-28

### Added
- **Daemon-split architecture.** Two cooperating processes:
  - `kongcode-daemon`: long-lived background process owning `SurrealStore`, `EmbeddingService`, ACAN weights, all 12 tool + 10 hook handlers
  - `kongcode-mcp`: thin per-Claude-Code-session client; forwards MCP RPC to daemon via JSON-RPC 2.0 over Unix socket (TCP loopback fallback for Windows)
- Multiple Claude Code sessions share one daemon; one BGE-M3 in RAM regardless of session count
- Daemon survives plugin updates, MCP restarts, and Claude Code crashes via `detached: true, unref()`
- SEA binaries built for linux-x64/arm64, macOS-arm64, win32-x64 (macOS-x64 still falls back to JS)

## [0.6.x series] — 2026-04-28

Self-contained first-run bootstrap shipped:

- `src/engine/bootstrap.ts` provisions SurrealDB binary, BGE-M3 GGUF model, node-llama-cpp native bindings on first run
- `bin-manifest.json` pins versions and per-platform sha256 hashes
- Auto-detects existing kongcode SurrealDB on legacy ports (8000, 8042) before spawning a managed child
- Various Windows-specific fixes (npm.cmd shell:true, PATH propagation guidance)

## [0.5.x series and earlier]

See `git log` for pre-0.6.0 history. Highlights:

- **0.5.4**: restored `userTurnCount` increment in `ingestTurn` (silent-failure regression from `4f7b962`)
- **0.5.1**: closed issue #5 (pending_work drain visibility)
- **0.4.0**: auto-seal contract — `commitKnowledge` auto-fires `narrower`/`broader`/`related_to`/`about_concept`/`mentions` edges on every write
- **0.3.0**: full Option A multi-MCP hardening (atomic weights save, training lockfile, mtime hot-reload)
- **0.2.0**: skill suite + grounding metric instrumentation
- **0.1.x**: initial port from KongBrain
