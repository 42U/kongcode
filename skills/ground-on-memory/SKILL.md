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
