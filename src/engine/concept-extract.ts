/**
 * Shared concept-extraction helpers.
 *
 * Regex-based extraction of concept names from text, plus helpers to
 * upsert extracted concepts and link them via arbitrary edge types.
 */

import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import { swallow } from "./errors.js";
import { commitKnowledge } from "./commit.js";

// Re-exports so downstream callers that imported these from concept-extract.js
// don't break after the 0.4.0 split (the functions moved to concept-links.ts).
export { linkToRelevantConcepts, linkConceptHierarchy } from "./concept-links.js";

// Verb-triggered extractor: captures a CapitalizedNoun (or two) that follows
// an action verb. Expanded beyond the original handful to cover conversational
// patterns like "fix X", "deploy X", "ship X", "run X", and trading actions.
export const CONCEPT_RE = /\b(?:use|using|implement|create|add|configure|setup|install|import|fix|deploy|ship|launch|run|test|check|monitor|update|hedge|build|refactor|audit|extract|classify|trigger)\s+([A-Z][a-zA-Z0-9_-]+(?:\s+[A-Z][a-zA-Z0-9_-]+)?)/g;

// Generic tech nouns — kept for backwards compatibility but the identifier
// patterns below surface the domain-specific jargon that actually matters.
export const TECH_TERMS = /\b(api|database|schema|migration|endpoint|middleware|component|service|module|handler|controller|model|interface|type|class|function|method|hook|plugin|extension|config|cache|queue|worker|daemon)\b/gi;

// snake_case or dotted identifiers: smart_mm_bot, hedge_lock, reply_log.csv
const IDENT_SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g;
// kebab-case identifiers: follow-up, hedge-lock, reply-banner
const IDENT_KEBAB = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,})\b/g;
// All-caps tickers/acronyms of length >= 3: KXETH, KXFED, SMTP, IMAP, SMS
const ACRONYM = /\b([A-Z]{3,}[A-Z0-9]*)\b/g;
// Tokens that look like project/product nouns: repeated CapWords (2 occurrences => keep)
const CAP_WORD = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

const STOPWORDS = new Set([
  "this", "that", "these", "those", "there", "here", "when", "where",
  "what", "which", "while", "with", "from", "into", "onto", "about",
  "after", "before", "between", "through",
]);

/** Default upper bound on concepts returned per text. Override per call. */
export const DEFAULT_CONCEPT_CAP = 20;

/** Extract concept name strings from free text using regex heuristics. */
export function extractConceptNames(text: string, max: number = DEFAULT_CONCEPT_CAP): string[] {
  const concepts = new Set<string>();

  // 1. Verb-triggered concept names (CapitalizedNoun after action verbs)
  let match: RegExpExecArray | null;
  const re1 = new RegExp(CONCEPT_RE.source, CONCEPT_RE.flags);
  while ((match = re1.exec(text)) !== null) {
    concepts.add(match[1].trim());
  }

  // 2. Generic tech nouns (lowercased)
  const re2 = new RegExp(TECH_TERMS.source, TECH_TERMS.flags);
  while ((match = re2.exec(text)) !== null) {
    concepts.add(match[1].toLowerCase());
  }

  // 3. snake_case, kebab-case, ALLCAPS identifiers. Surfaces domain-specific
  //    jargon: smart_mm_bot, hedge-lock, KXETH, check_replies_imap.
  const counts = new Map<string, number>();
  const bump = (s: string) => counts.set(s, (counts.get(s) ?? 0) + 1);

  for (const re of [IDENT_SNAKE, IDENT_KEBAB, ACRONYM, CAP_WORD]) {
    const r = new RegExp(re.source, re.flags);
    while ((match = r.exec(text)) !== null) {
      const tok = match[1];
      if (!tok || tok.length < 3) continue;
      if (STOPWORDS.has(tok.toLowerCase())) continue;
      bump(tok);
    }
  }

  // Only keep identifier-like tokens that either appear 2+ times OR match a
  // high-signal shape (snake_case / kebab-case / ALLCAPS with digits).
  for (const [tok, n] of counts) {
    if (n >= 2) {
      concepts.add(tok);
      continue;
    }
    if (/[_-]/.test(tok) || /^[A-Z0-9]+$/.test(tok)) {
      concepts.add(tok);
    }
  }

  return [...concepts].slice(0, Math.max(0, max));
}

/**
 * Upsert concepts from text and link them to a source node via the given edge.
 *
 * Used for:
 *  - turn  → "mentions"          → concept  (existing behaviour)
 *  - memory → "about_concept"    → concept  (Fix 1)
 *  - artifact → "artifact_mentions" → concept (Fix 2)
 */
export async function upsertAndLinkConcepts(
  sourceId: string,
  edgeName: string,
  text: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
  opts?: { taskId?: string; projectId?: string },
): Promise<void> {
  const names = extractConceptNames(text);
  if (names.length === 0) return;

  for (const name of names) {
    try {
      // Route every concept creation through commitKnowledge so hierarchy
      // (narrower/broader) + related_to auto-seal for this concept. Before
      // 0.4.0 this function called store.upsertConcept directly and only
      // wired the source→concept edge — every caller (ingestTurn,
      // after-tool-call, gems pre-Stage-B, etc.) was silently leaving
      // concepts unlinked within the concept graph itself.
      const { id: conceptId } = await commitKnowledge(
        { store, embeddings },
        {
          kind: "concept",
          name,
          sourceId,
          edgeName,
          source: logTag,
        },
      );

      if (conceptId) {
        // Outgoing task/project relations aren't part of generic auto-seal;
        // they're route-specific semantics that callers opt into.
        if (opts?.taskId) {
          await store.relate(conceptId, "derived_from", opts.taskId)
            .catch(e => swallow(`${logTag}:derived_from`, e));
        }
        if (opts?.projectId) {
          await store.relate(conceptId, "relevant_to", opts.projectId)
            .catch(e => swallow(`${logTag}:relevant_to`, e));
        }
      }
    } catch (e) {
      swallow(`${logTag}:upsert`, e);
    }
  }
}

// linkToRelevantConcepts and linkConceptHierarchy moved to concept-links.ts
// in 0.4.0 to break the potential circular import between this file and
// commit.ts. They remain re-exported from this module at the top so
// existing callers don't need to change imports.
