import type { EmbeddingConfig } from "./config.js";
/** Snapshot of the embedding service's init state, surfaced via diagnostics. */
export interface EmbeddingDiagnostics {
    ready: boolean;
    modelPath: string;
    initStartedAt: number | null;
    initFinishedAt: number | null;
    initDurationMs: number | null;
    initError: {
        message: string;
        stack?: string;
    } | null;
}
/** BGE-M3 embedding service (1024-dim via GGUF) with an LRU cache of up to 512 entries. */
export declare class EmbeddingService {
    private readonly config;
    private model;
    private ctx;
    private ready;
    /** LRU embedding cache keyed by text, capped at maxCacheSize entries. */
    private cache;
    private readonly maxCacheSize;
    private initStartedAt;
    private initFinishedAt;
    private initError;
    constructor(config: EmbeddingConfig);
    /** Initialize the embedding model. Returns true if freshly loaded, false if already ready. */
    initialize(): Promise<boolean>;
    /** Snapshot init state — used by introspect/memory_health probes to name failures. */
    getDiagnostics(): EmbeddingDiagnostics;
    /** Return the embedding vector for text, serving from LRU cache on repeat calls. */
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    isAvailable(): boolean;
    dispose(): Promise<void>;
}
