/**
 * Cognitive Bootstrap — teaches the agent HOW to use its own memory system.
 *
 * Seeds two types of knowledge on first run:
 *   1. Tier 0 core memory entries (always loaded every turn) — imperative
 *      reflexes the agent follows without thinking.
 *   2. Identity chunks (vector-searchable) — deeper reference material
 *      that surfaces via similarity when the agent thinks about memory topics.
 *
 * The identity chunks in identity.ts tell the agent WHAT it is.
 * This module tells the agent HOW to operate effectively.
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/**
 * Version tag for the cognitive bootstrap content. Bump this when CORE_ENTRIES
 * or IDENTITY_CHUNKS change; seedCognitiveBootstrap uses it to detect stale
 * seeds and re-seed on upgrade.
 */
export declare const BOOTSTRAP_VERSION = "0.4.0";
/**
 * Seed cognitive bootstrap knowledge on first run.
 * Idempotent — checks for existing entries before seeding.
 */
export declare function seedCognitiveBootstrap(store: SurrealStore, embeddings: EmbeddingService): Promise<{
    identitySeeded: number;
    coreSeeded: number;
}>;
