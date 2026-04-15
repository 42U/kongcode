#!/usr/bin/env bash
# KongCode Production Upgrade — idempotent task executor
#
# Usage:
#   ./exec.sh status                 # print plan progress
#   ./exec.sh next                   # print next pending task with resolved deps
#   ./exec.sh run <task_id>          # run a single task by id
#   ./exec.sh phase <n>              # run all tasks for phase N in dep order
#   ./exec.sh init                   # init tracking directories
#   ./exec.sh log "<msg>"            # append a log line to plan.json
#
# Design:
#   - plan.json is the source of truth. Every task has an `action` which maps to
#     a bash function in this script. Running a task calls the function and updates
#     plan.json status/notes.
#   - All edits to kongcode source are driven through this script so everything
#     is tracked. Patches use Python for multiline correctness.
#   - Safe to re-run: every task is idempotent; already-completed tasks are skipped
#     unless forced with `run --force`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN="$SCRIPT_DIR/plan.json"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_OUT="$SCRIPT_DIR/audit-result.json"

# ── JSON helpers (require jq) ─────────────────────────────────────────────

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "FATAL: $1 is required but not installed" >&2
    exit 1
  }
}

now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

_json_write() {
  # Safely replace plan.json via a jq-transformed temp file.
  local filter="$1"
  shift
  jq "$@" "$filter" "$PLAN" > "$PLAN.tmp"
  mv "$PLAN.tmp" "$PLAN"
}

log() {
  local msg="$1"
  local ts
  ts=$(now_utc)
  echo "[$ts] $msg" >&2
  _json_write '.log += [{"ts": $ts, "msg": $msg}] | .meta.last_updated = $ts' \
    --arg ts "$ts" --arg msg "$msg"
}

set_task_status() {
  local task_id="$1"
  local status="$2"
  local note="${3:-}"
  local ts
  ts=$(now_utc)
  if [ -n "$note" ]; then
    _json_write '.tasks[$id].status = $s | .tasks[$id].notes += [{"ts": $ts, "note": $n}] | .meta.last_updated = $ts' \
      --arg id "$task_id" --arg s "$status" --arg n "$note" --arg ts "$ts"
  else
    _json_write '.tasks[$id].status = $s | .meta.last_updated = $ts' \
      --arg id "$task_id" --arg s "$status" --arg ts "$ts"
  fi
}

set_phase_status() {
  local phase_id="$1"
  local status="$2"
  _json_write '.phases[$p].status = $s | .meta.last_updated = $ts' \
    --arg p "$phase_id" --arg s "$status" --arg ts "$(now_utc)"
}

get_task_field() {
  local task_id="$1"
  local field="$2"
  jq -r --arg id "$task_id" --arg f "$field" '.tasks[$id][$f] // ""' "$PLAN"
}

task_deps() {
  jq -r --arg id "$1" '.tasks[$id].deps[]? // empty' "$PLAN"
}

task_status() {
  jq -r --arg id "$1" '.tasks[$id].status // "unknown"' "$PLAN"
}

deps_satisfied() {
  local task_id="$1"
  local dep
  for dep in $(task_deps "$task_id"); do
    local s
    s=$(task_status "$dep")
    if [ "$s" != "completed" ] && [ "$s" != "skipped" ]; then
      echo "$dep ($s)"
      return 1
    fi
  done
  return 0
}

update_metric() {
  local key="$1"
  local value="$2"
  local ts
  ts=$(now_utc)
  _json_write '.metrics[$k].current = ($v | tonumber) | .metrics[$k].history += [{"ts": $ts, "value": ($v | tonumber)}] | .meta.last_updated = $ts' \
    --arg k "$key" --arg v "$value" --arg ts "$ts"
}

# ── Task actions ──────────────────────────────────────────────────────────

#
# phase0.audit — exhaustive $id bug sweep across src/
#
action_audit_bugs() {
  log "audit_bugs: sweeping src/ for remaining UPDATE/SELECT/DELETE \$anyId patterns"
  cd "$REPO"
  # Look for parameterized UPDATE/SELECT/DELETE with $id-style params AND
  # an accompanying `{ id: ... }` or `{ ...Id: ... }` params object.
  local hits
  hits=$(grep -rEn '(UPDATE|SELECT \* FROM|SELECT [a-zA-Z_, ]+ FROM|DELETE) \$[a-zA-Z_][a-zA-Z0-9_]*( |\`)' src/ 2>/dev/null \
    | grep -v '\.d\.ts:' \
    | grep -v 'SurrealDB rejects' \
    | grep -v 'workRecordId' || true)

  if [ -z "$hits" ]; then
    log "audit_bugs: clean"
    echo '{"clean": true, "hits": []}' > "$AUDIT_OUT"
    set_task_status phase0.audit completed "clean"
    return 0
  fi

  echo "$hits" | tee "$AUDIT_OUT.raw"
  # Build JSON result
  python3 - "$AUDIT_OUT.raw" "$AUDIT_OUT" << 'PY'
import json, sys
with open(sys.argv[1]) as f:
    lines = [l.rstrip() for l in f if l.strip()]
hits = []
for l in lines:
    try:
        file_part, rest = l.split(':', 1)
        line_no, content = rest.split(':', 1)
        hits.append({"file": file_part, "line": int(line_no), "content": content.strip()})
    except ValueError:
        hits.append({"raw": l})
with open(sys.argv[2], 'w') as f:
    json.dump({"clean": False, "count": len(hits), "hits": hits}, f, indent=2)
PY
  rm -f "$AUDIT_OUT.raw"

  local n
  n=$(jq '.count' "$AUDIT_OUT")
  log "audit_bugs: found $n suspicious sites (see audit-result.json). Most may be false positives — inspect manually."

  # Classify each hit as "needs_fix" or "already_safe" by checking if the line is
  # inside a block that has an assertRecordId call nearby (within 5 lines above).
  python3 - "$AUDIT_OUT" "$REPO" << 'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2])
data = json.loads(p.read_text())
if data.get("clean"): sys.exit(0)
for h in data["hits"]:
    if "file" not in h: continue
    f = repo / h["file"]
    if not f.exists(): continue
    lines = f.read_text().splitlines()
    start = max(0, h["line"] - 6)
    window = "\n".join(lines[start:h["line"]])
    # Safe if the 5 lines above contain assertRecordId OR the comment about direct interpolation
    safe = ("assertRecordId" in window) or ("Direct interpolation safe" in window) or ("assertWorkRecordId" in window)
    h["classification"] = "safe" if safe else "needs_review"
p.write_text(json.dumps(data, indent=2))
PY

  # Count needs_review
  local nr
  nr=$(jq '[.hits[] | select(.classification == "needs_review")] | length' "$AUDIT_OUT")
  if [ "$nr" -eq 0 ]; then
    log "audit_bugs: all $n hits classified as safe (assertRecordId or equivalent guard present above)"
    set_task_status phase0.audit completed "all_$n_safe"
  else
    log "audit_bugs: $nr sites need review out of $n total hits"
    set_task_status phase0.audit completed "needs_review=$nr total=$n"
  fi
}

#
# phase0.test — write a minimal vitest that exercises the UPDATE $id code path shape
#
action_write_regression_test() {
  log "write_regression_test: creating test/pending-work-update-id.test.ts"
  local target="$REPO/test/pending-work-update-id.test.ts"

  cat > "$target" << 'TSEOF'
/**
 * Regression test for the UPDATE $id bug class.
 *
 * Context: SurrealDB rejects `UPDATE $id SET ...` when $id is a plain string
 * parameter — the surreal-js client serializes strings as strings, not as
 * RecordId types. The only query shape that works is either:
 *   (a) direct interpolation after assertRecordId validation, OR
 *   (b) passing a true RecordId instance as the param (which we don't do
 *       anywhere in the codebase).
 *
 * This test scans the compiled sources for any remaining `UPDATE $id`,
 * `SELECT * FROM $id`, or `DELETE $id` patterns where the surrounding code
 * does NOT contain an assertRecordId or direct-interpolation-safe marker.
 *
 * It's a static-analysis test, not a SurrealDB integration test — much
 * faster in CI and catches the regression at source-review time without
 * requiring a running DB.
 *
 * To convert this into a full integration test later, add Docker-backed
 * SurrealDB fixture and call handleFetchPendingWork + handleCommitWorkResults
 * end-to-end. That's out of scope for the first version.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  content: string;
  safe: boolean;
}

function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const hits: Hit[] = [];
  const pattern = /\b(UPDATE|SELECT\s+\*\s+FROM|DELETE)\s+\$[a-zA-Z_][a-zA-Z0-9_]*\b/;

  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue;
    // Check the 6 lines above for an assertRecordId / assertWorkRecordId /
    // safety marker comment.
    const start = Math.max(0, i - 6);
    const window = lines.slice(start, i + 1).join("\n");
    const safe =
      /assertRecordId/.test(window) ||
      /assertWorkRecordId/.test(window) ||
      /Direct interpolation safe/.test(window) ||
      /SurrealDB rejects/.test(window);
    hits.push({ file, line: i + 1, content: lines[i].trim(), safe });
  }
  return hits;
}

describe("UPDATE $id regression", () => {
  it("has no unsafe UPDATE/SELECT/DELETE $id patterns in src/", () => {
    const files = walk(SRC_ROOT);
    const allHits: Hit[] = [];
    for (const f of files) {
      allHits.push(...scan(f));
    }
    const unsafe = allHits.filter(h => !h.safe);
    if (unsafe.length > 0) {
      const details = unsafe.map(h =>
        `  ${h.file.replace(SRC_ROOT, "src")}:${h.line}  ${h.content}`
      ).join("\n");
      throw new Error(
        `Found ${unsafe.length} unsafe $id SQL patterns without ` +
        `assertRecordId guard:\n${details}\n\n` +
        `Fix: assertRecordId(id) + \`UPDATE \${id} SET ...\` direct interpolation. ` +
        `See src/engine/surreal.ts relate() for the canonical pattern.`
      );
    }
    expect(unsafe.length).toBe(0);
  });
});
TSEOF

  log "write_regression_test: wrote $target"
  set_task_status phase0.test completed "$(wc -l < "$target") lines"
}

#
# build — run tsc and verify clean
#
action_build() {
  local phase="${1:-0}"
  log "build: running tsc for phase $phase"
  cd "$REPO"
  if npm run build 2>&1 | tee "$SCRIPT_DIR/build-phase$phase.log"; then
    log "build: phase $phase clean"
    set_task_status "phase$phase.build" completed "clean"
    return 0
  else
    log "build: phase $phase FAILED (see build-phase$phase.log)"
    set_task_status "phase$phase.build" failed "tsc errors"
    return 1
  fi
}

#
# restart_gate — a manual step; mark as awaiting user
#
action_restart_gate() {
  local phase="${1:-0}"
  log "restart_gate: phase $phase awaiting user to restart Claude Code"
  set_task_status "phase$phase.restart_gate" awaiting_user "restart Claude Code to load new daemon binary"
}

#
# verify_post_restart — run after user restart to confirm fetch_pending_work works
# (this task is called from inside a Claude session AFTER restart, so it can only
#  be executed via Claude issuing MCP tool calls, not pure bash. We leave a stub
#  that prints instructions.)
#
action_verify_post_restart() {
  cat <<'MSG'
verify_post_restart: CLAUDE MUST RUN THIS
==========================================
After restart, Claude should call the following MCP tools and paste results:

  1. mcp__plugin_kongcode_kongcode__introspect { action: "status" }
     - expected: ping OK, no errors, concepts/embedded ratio 100%
  2. mcp__plugin_kongcode_kongcode__fetch_pending_work
     - expected: either {empty: true, ...} or a valid work item JSON
     - NOT expected: "Parse error", "Cannot execute UPDATE statement"
  3. mcp__plugin_kongcode_kongcode__recall { query: "Yang AT volatility", limit: 3 }
     - expected: 3 results with score > 0.4

Then call: ./exec.sh mark phase0.verify completed "<summary>"
MSG
  set_task_status phase0.verify awaiting_user "see printed checklist"
}

#
# phase1.arch_systemreminder — wrap injected context in a <system-reminder> block
#
action_apply_system_reminder_wrapping() {
  log "apply_system_reminder_wrapping: locating hook handler"
  cd "$REPO"
  local hook_file="src/hook-handlers/user-prompt-submit.ts"
  if [ ! -f "$hook_file" ]; then
    log "FATAL: $hook_file not found — hook handler may have moved"
    set_task_status phase1.arch_systemreminder failed "hook file missing"
    return 1
  fi

  # Detect if the wrapping already exists (idempotent)
  if grep -q "KONGCODE CONTEXT" "$hook_file" 2>/dev/null; then
    log "apply_system_reminder_wrapping: already applied (idempotent skip)"
    set_task_status phase1.arch_systemreminder completed "already wrapped"
    return 0
  fi

  # Patch via python — find the additionalContext assignment and wrap it
  python3 - "$hook_file" << 'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
src = p.read_text()

# Strategy: find `additionalContext: <expr>` or `additionalContext = <expr>`
# inside the handler return. Wrap the string value in a template literal that
# adds the system-reminder preamble.
#
# Rather than modifying the assignment, we insert a helper at the top of the
# file and replace the additionalContext production to go through it.

HELPER = '''
/** Wrap raw kongcode context in a system-reminder block so Claude treats it
 * as authoritative. Claude Code's harness gives system-reminder blocks higher
 * attention weight than plain injected text — empirically the plain-text
 * injection was hitting ~10% retrieval utilization because the model read it
 * as ambient noise. */
function wrapKongcodeContext(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return raw ?? "";
  return [
    "<system-reminder>",
    "KONGCODE CONTEXT — authoritative for this turn.",
    "Before your first text output or tool call, scan the items below and",
    "identify any relevant to the user's prompt. If you respond without",
    "grounding on relevant items, that is a correctness error. If no items",
    "are relevant, explicitly note that rather than pretending they aren't",
    "there. Cite items by their concept id when citing.",
    "",
    raw.trim(),
    "</system-reminder>",
  ].join("\\n");
}
'''

# Insert helper after the import block
import_end = 0
for m in re.finditer(r'^import .*?;\s*$', src, re.MULTILINE):
    import_end = m.end()
if import_end == 0:
    print("FATAL: no import block found", file=sys.stderr); sys.exit(1)

src = src[:import_end] + "\n" + HELPER + src[import_end:]

# Find additionalContext assignments or returns and wrap
# Case 1: `additionalContext: someExpr,`  → `additionalContext: wrapKongcodeContext(someExpr),`
src = re.sub(
    r'additionalContext:\s*([^,\n}]+?)(,|\n|\})',
    lambda m: f'additionalContext: wrapKongcodeContext({m.group(1).strip()}){m.group(2)}',
    src,
)
# Case 2: `makeHookOutput("UserPromptSubmit", someExpr)` (second arg is the context)
src = re.sub(
    r'makeHookOutput\(\s*"UserPromptSubmit"\s*,\s*([^,)]+?)(\s*[,)])',
    lambda m: f'makeHookOutput("UserPromptSubmit", wrapKongcodeContext({m.group(1).strip()}){m.group(2)}',
    src,
)

p.write_text(src)
print(f"patched {p}")
PY

  log "apply_system_reminder_wrapping: patched $hook_file"
  set_task_status phase1.arch_systemreminder completed "patched"
}

#
# phase1.skill_ground — write skills/ground-on-memory/SKILL.md
#
action_write_skill_ground_on_memory() {
  log "write_skill_ground_on_memory: creating skills/ground-on-memory/SKILL.md"
  mkdir -p "$REPO/skills/ground-on-memory"
  cat > "$REPO/skills/ground-on-memory/SKILL.md" << 'SKILLEOF'
---
name: Ground on Memory
description: Activate when the user asks about state, history, prior work, codebase knowledge, or anything where injected memory should inform the response. Triggers include "what do you know about", "remember", "earlier", "last time", "we discussed", "in this codebase", "prior work", "previously", or any direct question about project/session state.
version: 0.1.0
---

# Ground on Memory

**Purpose**: force explicit grounding on kongcode-injected context before Claude responds. This skill exists because the `retrieval utilization` metric on kongcode historically sat at 10% — context was being retrieved and injected but ignored. The graph works; the grounding discipline doesn't. This skill is that discipline.

## The core rule

**Before your first text output or tool call in response to any user turn matching this skill's triggers:**

1. **Scan the current turn's injected context block** (look for `<system-reminder>KONGCODE CONTEXT`). If present, it contains concepts, memories, skills, and reflections retrieved by the kongcode hook based on your user's prompt.
2. **Identify which injected items are relevant** to the current user prompt. Be honest — not everything injected will be relevant, and pretending otherwise is noise.
3. **Choose one of three paths:**
   - **Relevant items exist** → your response must cite or apply them. Reference them by concept id or content fragment when the user would benefit from knowing the source.
   - **Relevant items exist but contradict your default answer** → surface the contradiction explicitly before responding. Either reconcile or flag the disagreement for the user.
   - **No relevant items exist** → explicitly note "no relevant memory found for this question — responding from current reasoning only." Do not pretend the injection wasn't there.

## Why this exists

Kongcode's whole architecture assumes that Claude will ground on the memory graph. If Claude ignores it, every other upgrade to the graph is wasted effort. The system-reminder wrapping on injected context (Phase 1 arch upgrade) exists to signal authority, but signalling is necessary, not sufficient. This skill is the enforcement half.

Every session where you respond without grounding on relevant injected context lowers the `retrieval_utilization` metric. Every session where you ground consistently raises it. The metric moving is the most reliable signal that kongcode is working as a system.

## What grounding looks like in practice

**Bad (ungrounded):**
> User: What do I usually pick as an instrumental variable in my AT studies?
> You: You could use the Shanghai-Hong Kong Stock Connect program's expansion as an IV, since it creates exogenous variation in algo activity...

**Good (grounded):**
> User: What do I usually pick as an instrumental variable in my AT studies?
> You: From your memory graph: you've used **Shenzhen-Hong Kong Stock Connect list membership** as the primary IV (see concept `sc_as_instrumental_variable` from Yang et al. 2025), with **order-to-trade ratio (OTR)** as a secondary IV (concept `otr_as_second_instrumental_variable`). Both exploit exogenous variation — SC from regulatory list entry, OTR from Italian SE fine precedent. Want me to elaborate on either, or find other IV strategies in the graph?

Notice the grounded version: (1) tells the user kongcode had an answer, (2) cites the specific concepts by name, (3) summarizes what the memory said, (4) offers to go deeper. That's the template.

## When to NOT ground

- The user asks a pure reasoning question with no historical context needed ("what is 2+2", "write a sort function").
- The injected context is obviously irrelevant (user asks about options trading, memory contains only calculus papers).
- The user explicitly says "ignore memory" or "fresh answer" or similar.

In those cases, still note "no grounding needed here" internally and proceed. Don't force-cite irrelevant content just to satisfy the skill.

## Relationship to other skills

- **`kongcode-health`**: if health is RED, this skill should note the degradation but still try to ground on whatever context is available.
- **`recall-explain`** (phase 2): when the injected block is insufficient, this skill can call recall-explain for a deeper search with narrative output.
- **`capture-insight`** (phase 2): when grounding reveals a gap, this skill can invoke capture-insight to write the current finding into the graph for future turns.

## Failure modes

- **Performative citation**: citing injected items without actually using them in the answer. Don't do this — the grounding audit is supposed to be a belief filter, not a decoration.
- **Over-fitting to injected content when it's stale**: if the injected concept is from months ago and your current reasoning disagrees, flag it as potential drift and propose superseding (phase 3 `supersede-stale` skill).
- **Forgetting the "no memory found" escape**: sometimes the right answer is "no graph coverage on this topic." Say it explicitly.

## Metric this skill drives

`retrieval_utilization` — baseline 10%, phase 1 target 25%, final target 40%+. This is the only skill that directly moves this number. Every other kongcode upgrade is infrastructure; this is the behavior change.
SKILLEOF

  log "write_skill_ground_on_memory: wrote skills/ground-on-memory/SKILL.md"
  set_task_status phase1.skill_ground completed
}

#
# phase1.measure_start — record current retrieval_utilization as baseline
# (This can only be done from inside Claude; we leave a stub.)
#
action_measure_retrieval_utilization() {
  cat <<'MSG'
measure_retrieval_utilization: CLAUDE MUST RUN THIS
====================================================
From inside a Claude session with kongcode MCP tools loaded:
  1. Call mcp__plugin_kongcode_kongcode__introspect { action: "status" }
  2. Read the `retrieval util: XX%` line from the SOUL GRADUATION section
  3. Run: ./exec.sh metric retrieval_utilization <value>
MSG
  set_task_status phase1.measure_start awaiting_user "run from Claude session"
}

# ── Stubs for later phases (will be filled in when reached) ──────────────

action_apply_recall_graph_neighborhoods() { echo "phase2.arch_recall_edges — not yet implemented"; return 2; }
action_apply_retrieval_reason_field() { echo "phase2.arch_retrieval_reason — not yet implemented"; return 2; }
action_write_skill_recall_explain() { echo "phase2.skill_recall_explain — not yet implemented"; return 2; }
action_write_skill_capture_insight() { echo "phase2.skill_capture_insight — not yet implemented"; return 2; }
action_apply_concept_provenance() { echo "phase3.arch_provenance — not yet implemented"; return 2; }
action_apply_edge_vocabulary() { echo "phase3.arch_edge_vocab — not yet implemented"; return 2; }
action_write_skill_supersede_stale() { echo "phase3.skill_supersede_stale — not yet implemented"; return 2; }
action_write_skill_extract_knowledge() { echo "phase3.skill_extract_knowledge — not yet implemented"; return 2; }
action_write_skill_synthesize_sources() { echo "phase4.skill_synthesize — not yet implemented"; return 2; }
action_write_skill_gap_scan() { echo "phase4.skill_gap_scan — not yet implemented"; return 2; }
action_write_skill_audit_drift() { echo "phase4.skill_audit_drift — not yet implemented"; return 2; }
action_write_workflows_doc() { echo "phase5.workflows_doc — not yet implemented"; return 2; }
action_update_readme() { echo "phase5.readme_update — not yet implemented"; return 2; }

# ── Dispatcher ─────────────────────────────────────────────────────────────

dispatch() {
  local task_id="$1"
  local action
  action=$(get_task_field "$task_id" "action")
  if [ -z "$action" ]; then
    echo "FATAL: task '$task_id' has no action" >&2
    return 1
  fi
  local fn="action_$action"
  if ! declare -F "$fn" > /dev/null; then
    echo "FATAL: no bash function '$fn' for task '$task_id'" >&2
    return 1
  fi

  # Check deps
  local unmet
  unmet=$(deps_satisfied "$task_id") || {
    echo "task '$task_id' blocked on unmet dep: $unmet" >&2
    return 3
  }

  # Idempotent skip
  local current
  current=$(task_status "$task_id")
  if [ "$current" = "completed" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "task '$task_id' already completed (pass FORCE=1 to rerun)" >&2
    return 0
  fi

  set_task_status "$task_id" in_progress
  # Parse phase number from task_id (e.g. phase0.build → 0)
  local phase_num="${task_id#phase}"
  phase_num="${phase_num%%.*}"
  if "$fn" "$phase_num"; then
    # If the action didn't explicitly set_task_status, mark complete
    local after
    after=$(task_status "$task_id")
    if [ "$after" = "in_progress" ]; then
      set_task_status "$task_id" completed
    fi
    return 0
  else
    local after
    after=$(task_status "$task_id")
    if [ "$after" = "in_progress" ]; then
      set_task_status "$task_id" failed "action returned non-zero"
    fi
    return 1
  fi
}

run_phase() {
  local phase_num="$1"
  local phase_id="phase$phase_num"
  local tasks
  tasks=$(jq -r --arg p "$phase_id" '.phases[$p].tasks[]? // empty' "$PLAN")
  if [ -z "$tasks" ]; then
    echo "FATAL: phase '$phase_id' not found or has no tasks" >&2
    return 1
  fi
  set_phase_status "$phase_id" in_progress
  local any_awaiting=0
  local any_failed=0
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    echo "── $t ─────────────────────────────"
    if dispatch "$t"; then
      local s
      s=$(task_status "$t")
      if [ "$s" = "awaiting_user" ]; then any_awaiting=1; fi
    else
      any_failed=1
      echo "task $t did not complete cleanly — stopping phase" >&2
      break
    fi
  done <<< "$tasks"
  if [ "$any_failed" = "1" ]; then
    set_phase_status "$phase_id" blocked
    return 1
  elif [ "$any_awaiting" = "1" ]; then
    set_phase_status "$phase_id" awaiting_user
    return 0
  else
    set_phase_status "$phase_id" completed
    return 0
  fi
}

cmd_status() {
  jq -r '
    .phases | to_entries[] |
    "\(.key): \(.value.status) — " + ([.value.tasks[]? // empty] | length | tostring) + " tasks"
  ' "$PLAN"
  echo
  jq -r '
    .tasks | to_entries[] |
    "\(.key) [\(.value.status)] \(.value.description)"
  ' "$PLAN"
}

cmd_next() {
  jq -r '
    .tasks | to_entries |
    map(select(.value.status == "pending")) |
    .[0] // "all tasks complete or in awaiting_user state"
  ' "$PLAN"
}

cmd_metric() {
  local key="$1"
  local value="$2"
  update_metric "$key" "$value"
  log "metric: $key = $value"
}

cmd_mark() {
  local task_id="$1"
  local status="$2"
  local note="${3:-}"
  set_task_status "$task_id" "$status" "$note"
  log "mark: $task_id → $status${note:+ ($note)}"
}


cmd_util() {
  # Windowed retrieval_utilization analyzer. Run a node script that hits
  # SurrealDB directly and computes per-window averages. Updates plan.json
  # metrics and prints a human summary.
  log "util: querying retrieval_outcome for windowed averages"
  cd "$REPO"
  node "$SCRIPT_DIR/tools/check-utilization.mjs"
}

# ── Entry point ────────────────────────────────────────────────────────────

# Load phase-specific action files (override stubs with real implementations).
# Each phaseN.sh file is sourced in lexical order, so the latest definition wins.
for _phase_file in "$SCRIPT_DIR/actions"/phase*.sh; do
  [ -f "$_phase_file" ] && source "$_phase_file"
done

need jq
need python3

cmd="${1:-}"
case "$cmd" in
  init)
    mkdir -p "$SCRIPT_DIR"
    log "init complete"
    ;;
  util) cmd_util ;;
  status) cmd_status ;;
  next) cmd_next ;;
  run)
    shift
    dispatch "$1"
    ;;
  phase)
    shift
    run_phase "$1"
    ;;
  log)
    shift
    log "$*"
    ;;
  metric)
    shift
    cmd_metric "$1" "$2"
    ;;
  mark)
    shift
    cmd_mark "$@"
    ;;
  "")
    cat <<'HELP'
KongCode Upgrade Executor

Usage:
  ./exec.sh status                  show phase/task status
  ./exec.sh next                    show next pending task
  ./exec.sh run <task_id>           run a single task (respects deps)
  ./exec.sh phase <N>               run all tasks in phase N in order
  ./exec.sh log "<msg>"             append log line to plan.json
  ./exec.sh metric <key> <value>    record a metric value
  ./exec.sh mark <task_id> <status> [note]   manually set task status
  ./exec.sh init                    init tracking directories

Current plan: .upgrade/plan.json
HELP
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
