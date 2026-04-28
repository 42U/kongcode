import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/**
 * Version tag for the core identity chunks. Bump when IDENTITY_CHUNKS
 * content changes so existing installs re-seed with the new content.
 * Pre-0.4.0 installs had no identity_version field on their chunks,
 * so the absence-of-field query doubles as the upgrade detector.
 */
export declare const IDENTITY_VERSION = "0.4.1";
export declare function seedIdentity(store: SurrealStore, embeddings: EmbeddingService): Promise<number>;
export declare function hasUserIdentity(store: SurrealStore): Promise<boolean>;
export declare function findWakeupFile(cwd: string): string | null;
export declare function readWakeupFile(path: string): string;
export declare function deleteWakeupFile(path: string): void;
export declare function saveUserIdentity(chunks: string[], store: SurrealStore, embeddings: EmbeddingService): Promise<number>;
export declare function buildWakeupPrompt(wakeupContent: string): {
    systemAddition: string;
    firstMessage: string;
};
