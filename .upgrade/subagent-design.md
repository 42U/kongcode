# Subagent Tracking — Design Spec (R3)

## Status
Feature **never implemented**. Schema table exists (`subagent`), hook handlers exist but are 2-line TODO stubs in `src/hook-handlers/subagent.ts`, original TODO comment says "Phase 5 will add subagent tracking." After 22+ days of use, `subagent: 0` rows.

This isn't a port-fix — KongBrain's subagent pattern is being re-architected around Claude Code's Task tool, which fires its own lifecycle events. Designing from scratch.

## Why track subagents

A KongCode session that spawns subagents is producing cognitive work the main session doesn't see:
- Different prompts, tools, and outcomes per agent
- Work attribution (which agent produced which artifact)
- Performance signal (duration, tool count, success rate per agent-type)
- Retrieval: "what did my subagents already do?" is a real recall query

Without tracking: subagent work happens, artifacts land, but the graph has no record of *who did what*. Every spawned-agent artifact looks like it came from the parent session.

## Claude Code hook surface (what we get)

Two hook events the MCP already registers but doesn't process:

1. **`TaskCreated`** — fires when the Task tool spawns a subagent
   - Expected payload: `{ session_id, agent_type, description, prompt, ...timestamps }`
   - `agent_type` is one of: `"general-purpose"`, `"Explore"`, `"Plan"`, user-defined types
   - `description` is the caller's short label
   - `prompt` is the full instruction (can be multi-KB)

2. **`SubagentStop`** — fires when a subagent finishes (success, error, or timeout)
   - Expected payload: `{ session_id, agent_id_or_task_id, result, ...timestamps }`
   - Critical: need a correlation key between TaskCreated and SubagentStop

**Open question for verification**: what is the stable correlation ID Claude Code passes between TaskCreated and SubagentStop? Needs a live hook capture. If no such ID exists, correlate via `(session_id, spawn_time_window)` — less robust.

## Schema proposal

Extend the existing `subagent` table (SCHEMALESS so no migration required):

```surql
-- Already in schema.surql:
DEFINE TABLE IF NOT EXISTS subagent SCHEMALESS;

-- Fields to populate:
subagent {
  id,
  parent_session_id:  string     -- the KongCode session that spawned it
  agent_type:         string     -- "general-purpose" | "Explore" | "Plan" | custom
  description:        string     -- <= 200 char caller label
  prompt_preview:     string     -- first ~500 chars of the full prompt
  prompt_length:      int        -- full length for analytics
  spawned_at:         datetime   -- server default time::now()
  ended_at:           datetime?  -- populated on SubagentStop
  duration_ms:        int?       -- end - spawn
  outcome:            string     -- "in_progress" | "completed" | "error" | "timeout" | "unknown"
  tool_call_count:    int?       -- if payload surfaces it
  result_summary:     string?    -- first ~500 chars of the result text
  correlation_key:    string     -- the ID we use to match Stop → Created
}
```

Indexes worth adding:
```surql
DEFINE INDEX IF NOT EXISTS subagent_parent_idx ON subagent FIELDS parent_session_id;
DEFINE INDEX IF NOT EXISTS subagent_corr_idx ON subagent FIELDS correlation_key;
```

## Edges

| Edge | Direction | Purpose |
|---|---|---|
| `spawned_from` | subagent → session | parent-session lookup |
| `produced` | subagent → artifact | work-attribution |
| `derived_from` | subagent → task | session→task hierarchy |

All three edge tables already exist; only wiring new.

## Hook wiring

### `handleTaskCreated`
```
1. Extract { session_id, agent_type, description, prompt, correlation_key } from payload
2. Resolve parent session via state.getSession(session_id) — if missing, swallow and return
3. Write subagent row:
   - outcome: "in_progress"
   - spawned_at: server default
   - prompt_preview: prompt.slice(0, 500)
   - prompt_length: prompt.length
4. Relate subagent → spawned_from → session (via store.relate)
5. Relate subagent → derived_from → session.taskId (via store.relate)
6. Stash correlation_key in session._activeSubagents Map<string, string> so
   SubagentStop can find the row to update
```

### `handleSubagentStop`
```
1. Extract { session_id, correlation_key, result, outcome } from payload
2. Look up subagent id via session._activeSubagents map
3. If found, UPDATE: set ended_at = time::now(),
                     duration_ms = <computed from spawned_at>,
                     outcome = payload.outcome ?? "completed",
                     result_summary = result.slice(0, 500)
4. If not found, write a bare-row subagent with correlation_key and what we know —
   so orphan stops don't drop data
5. Remove entry from session._activeSubagents
```

Both handlers: fire-and-forget writes via `swallow.warn` on errors. Never block the hook return.

## Integration with existing systems

- **Artifact attribution**: when `after-tool-call.ts` or `post-tool-use.ts` fires *inside a subagent's execution context*, the artifact it creates should `produced` edge to the subagent, not (just) the parent session. Requires threading the active-subagent-id through the hook chain. Deferred to v2 — v1 is enough to populate the table.
- **Soul graduation**: reflect subagent success rate in the quality score. Currently quality reads `skill_success` which is skill-graduation outcomes. Could add `subagent_success_rate` as a 5th quality signal (0.5.0 territory).
- **Recall**: when subagents populate, `recall` scoped to `"skills"` could also search subagent result_summaries — lets the parent session find "did a subagent already research this?"

## Implementation steps (proposed, for your approval)

Each is a small, separately committable unit:

1. **Schema additions** — add the index lines + maybe a typed schema for a few fields. `schema.surql` only. Tests pass as-is because schema is SCHEMALESS additive.

2. **SessionState field** — add `_activeSubagents: Map<string, string>` to track correlation. `state.ts` only.

3. **handleTaskCreated body** — implement the TODO stub. `subagent.ts` + test.

4. **handleSubagentStop body** — implement the TODO stub. `subagent.ts` + test.

5. **Integration test** — simulate a TaskCreated → SubagentStop cycle via direct hook POST and verify the row lands with the expected fields. Adds to `test/` as `subagent.test.ts`.

6. **(optional, 0.4.1) Artifact attribution** — thread subagent_id through after-tool-call and post-tool-use hooks. More invasive.

## Open questions for you

1. **Correlation ID verification.** I'm assuming Claude Code provides a stable ID across TaskCreated/SubagentStop. Need you to confirm by either:
   - Checking the Claude Code hook docs
   - Adding `log.info` to the current stub handlers and triggering a Task call to see the payload shape

2. **Scope — v1 vs v2.**
   - **v1 (recommended)**: rows appear, basic fields. Orphan stops get bare rows. Artifact attribution not threaded yet.
   - **v2**: artifact attribution too. More invasive; touches 3 hook handlers.

3. **Re-architecture vs port.** KongBrain had a subagent pattern built around the memory daemon (removed). This proposal is a fresh design for Claude Code's Task tool — no port regression, genuinely new surface. Want me to check KongBrain for anything worth keeping, or just design from scratch?

4. **Timing.** This is new feature work. Do you want it in 0.4.0 (push the tag), or 0.4.1 (ship 0.4.0 with what's there now)?

## What I'd do if you say "just execute"

My default plan, in order:
1. Add `log.info` to current stub handlers to capture payload shape (one commit, no behavior change, gives us the correlation ID question's answer)
2. You trigger a Task call in your next session → we see the payload → we design off real data
3. Ship v1 (5 commits, one per step above)
4. Defer v2 (artifact attribution) to a follow-up cycle

Total for v1: ~1-2 hours of work across a few sessions.
