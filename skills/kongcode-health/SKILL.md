---
name: KongCode Health Check
description: Activate when the user asks about kongcode status, health, whether memory is working, before extracting knowledge from a new source, or when recall/write operations appear to be failing. Also activate for phrases like "is kongcode working", "check memory", "pipeline health", "anything broken".
version: 0.1.0
---

# KongCode Health Check

Pre-flight check before any significant graph write or heavy recall session. Runs a fixed sequence of probes and returns a single-line verdict (GREEN / YELLOW / RED) plus specific diagnoses.

Run this skill **before `/extract-pdf-gems`** and **before any session that will write a lot to the graph**. It catches silent regressions that would otherwise corrupt a batch of writes.

## Check sequence

Execute each in order. Do not skip on "probably fine" — the whole point is to catch regressions you can't see.

### 1. Database ping + record counts (`introspect` status)

Call `mcp__plugin_kongcode_kongcode__introspect` with `action: "status"`.

**Pass**: `Connection: OK`, ping OK, concept embedded count matches concept total count (or gap is <5% of recent adds). Record totals non-zero across the core tables (`concept`, `turn`, `artifact`, `memory`, `session`).

**Warn** (YELLOW): embedding gap >10% on concepts, or gap on turns > 200, or any table total is zero that shouldn't be.

**Fail** (RED): ping fails, connection broken, or total records dropped vs last-known baseline.

### 2. Recall smoke test

Call `mcp__plugin_kongcode_kongcode__recall` with `query: "algorithmic trading volatility"` (or any known-in-graph query — substitute as needed) and `limit: 5`.

**Pass**: at least 3 non-empty results with `score > 0.4`. Returns embedding-backed concepts, not empty/error.

**Warn**: returns 1–2 results or scores all <0.4 — embeddings may be stale or pipeline degraded.

**Fail**: returns empty, errors, or returns only `turn` results with no `concept` results (indicates embedding pipeline is stalled on concepts).

### 3. Pending work queue probe

Call `mcp__plugin_kongcode_kongcode__fetch_pending_work`.

**Pass**: returns either `{empty: true, message: "No pending work items..."}` or a valid work item JSON. Must not error.

**Warn**: returns a work item but claims stale (`processing` status started >10min ago — stale reset hasn't run).

**Fail**: SurrealDB error (`Parse error`, `Cannot execute UPDATE`, etc.). This flags a SurQL regression in pending-work.ts — the exact kind of bug that caused the original `UPDATE $id` chain to leak silently.

### 4. Quality metric check

From the introspect status output, read the `SOUL GRADUATION` section if present.

**Report**: retrieval utilization %, skill success %, tool failure %, critical reflections %. These are lagging indicators but worth showing — if retrieval_utilization jumps negatively, something changed.

No pass/fail on this one — it's diagnostic context, not a gate.

### 5. Embedding freshness on recent writes (optional, takes extra calls)

If the user just wrote gems in this session: issue a `recall` on a string that contains a word unique to the just-written content. Should surface the new concepts at score >0.5. If not, the embedding daemon is behind — flag it but don't block.

## Report format

Return the verdict as a tight one-liner followed by a bulleted diagnosis:

```
KONGCODE HEALTH: GREEN — pipeline operating normally.
- DB: 39,201 records, concepts 1189/1189 embedded (100%)
- Recall: 5 results, top score 0.68 — semantic retrieval working
- Pending work: empty queue, no parse errors
- Quality: retrieval 10% (unchanged), skill success 100%
```

Or on failure:

```
KONGCODE HEALTH: RED — fetch_pending_work is broken.
- DB: connected
- Recall: working
- Pending work: ERROR — "Cannot execute UPDATE statement using value: 'pending_work:xxx'"
- Diagnosis: UPDATE $id with string param bug in pending-work.ts. Daemon needs restart to pick up the fix, OR the fix hasn't been applied. Check git log on tools/pending-work.ts.
- Recommendation: do NOT write via create_knowledge_gems yet — session-extraction pipeline will silently fail to mark items complete, creating zombie pending_work rows.
```

## When to gate vs warn

- **GREEN**: proceed with any work
- **YELLOW**: proceed but document the degradation in your user-facing reply, and recheck after the write
- **RED**: do not write. Tell the user what's broken, propose a fix, wait for confirmation.

## Common root causes when health fails

- **Parse errors from SurQL**: someone edited a query file without testing. Check `git log` on `src/tools/pending-work.ts`, `src/engine/surreal.ts`, `src/hook-handlers/*.ts`.
- **Embedding gap growing**: BGE-M3 service down or daemon stalled. Check the embedding service health separately.
- **Recall returns empty but DB has records**: embedding column is missing on records. Run `introspect count` with `filter: "with_embedding"` to confirm.
- **Hook daemon socket missing**: `~/.kongcode.sock` gone — the MCP server process died and needs a Claude Code restart.

## What success looks like

- Report produced in under 5 seconds
- All 4 check steps run, none silently skipped
- Single-line verdict plus specific bullet diagnoses
- If RED, user has a clear next action (not just "it's broken")
