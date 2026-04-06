---
name: KongBrain Memory System
description: Activate when user mentions "search memory", "recall", "remember", "core memory", "introspect", "memory status", "what did we do", "past sessions", "identity", "soul", or when you need to store/retrieve persistent knowledge across sessions.
version: 0.1.0
---

# KongBrain Memory System

KongCode provides permanent graph memory via SurrealDB with BGE-M3 vector embeddings. Knowledge from every session is automatically extracted, stored, and retrieved.

## Automatic Context Injection

Every turn, the UserPromptSubmit hook retrieves relevant past knowledge and injects it as context. This happens transparently — check what was already injected before manually calling `recall`.

Injected context includes:
- **Graph context** — relevant memories, concepts, turns, artifacts from past sessions
- **Core memory** — always-loaded directives (Tier 0) and session-pinned context (Tier 1)
- **Skills** — learned reusable procedures
- **Reflections** — metacognitive lessons from past sessions

## Tools

### `recall` — Search Memory Graph
Search past knowledge across all stored types.

**Parameters:**
- `query` (required): Natural language search query
- `scope` (optional): `all` | `memories` | `concepts` | `turns` | `artifacts` | `skills`
- `limit` (optional): 1-15 results (default: 5)

**When to use:** When auto-injected context is insufficient, when explicitly asked about past work, when looking for specific files or decisions.

### `core_memory` — Manage Always-Loaded Directives
CRUD operations on persistent directives that load every turn.

**Parameters:**
- `action` (required): `list` | `add` | `update` | `deactivate`
- `tier` (optional): `0` (always loaded) or `1` (session-pinned)
- `category` (optional): `identity` | `rules` | `tools` | `operations` | `general`
- `text` (optional): Content for add/update
- `priority` (optional): 0-100 (higher = loaded first)
- `id` (optional): Record ID for update/deactivate

**Tier 0** entries appear in every single turn — use sparingly for identity rules and fundamental constraints. **Tier 1** entries are pinned for the current session only.

### `introspect` — Database Diagnostics
Inspect the memory database health and contents.

**Parameters:**
- `action` (required): `status` | `count` | `verify` | `query` | `migrate`
- `table` (optional): Table name for count/query
- `filter` (optional): `active` | `inactive` | `recent_24h` | `with_embedding` | `unresolved`
- `record_id` (optional): For verify action

## When to Store vs Retrieve

**Store** (via `core_memory add` or automatic extraction):
- User corrections and preferences
- Important architectural decisions
- Successful workflows and procedures
- File/project knowledge the user wants remembered

**Retrieve** (via `recall` or automatic injection):
- Before starting a task in a familiar codebase
- When context from prior sessions seems relevant
- When the user references past work

## Context Budget

The system manages token budgets adaptively per intent:
- Simple questions → minimal retrieval
- Code debugging → full graph search with skills
- Reference to prior work → elevated retrieval budget

Trust the orchestrator's adaptive budgeting — it classifies intent automatically.

## Soul / Identity System

After sufficient experience (15+ sessions, 10+ reflections, 5+ causal chains, 30+ concepts, 3+ days), the agent may graduate a **Soul** — a self-assessment of working style, observations, and values grounded in actual evidence. This is earned, not assigned. Do not fabricate soul content.

## Additional Resources
- references/graph-schema.md — Full table and edge documentation
- references/tool-reference.md — Detailed parameter specs with examples
- references/soul-system.md — Graduation thresholds and soul structure
