export interface SurrealConfig {
    url: string;
    httpUrl: string;
    user: string;
    pass: string;
    ns: string;
    db: string;
}
export interface EmbeddingConfig {
    modelPath: string;
    dimensions: number;
}
export interface ThresholdConfig {
    /** Tokens accumulated before daemon flushes extraction (default: 4000) */
    daemonTokenThreshold: number;
    /** Cumulative tokens before mid-session cleanup fires (default: 25000) */
    midSessionCleanupThreshold: number;
    /** Per-extraction timeout in ms (default: 60000) */
    extractionTimeoutMs: number;
    /** Max pending thinking blocks kept in memory (default: 20) */
    maxPendingThinking: number;
    /** Retrieval outcome samples needed before ACAN training (default: 5000) */
    acanTrainingThreshold: number;
}
export interface PathsConfig {
    /** Where downloaded artifacts (SurrealDB binary, model) live. Default ~/.kongcode/cache. Survives plugin updates. */
    cacheDir: string;
    /** Where the bootstrapped SurrealDB child process stores its surrealkv data. Default ~/.kongcode/data. */
    dataDir: string;
    /** Path to the SurrealDB binary. Default <cacheDir>/surreal-<version>/<binaryName>. */
    surrealBinPath: string | null;
}
export interface KongCodeConfig {
    surreal: SurrealConfig;
    embedding: EmbeddingConfig;
    thresholds: ThresholdConfig;
    paths: PathsConfig;
}
/** @deprecated Alias for backwards compatibility with engine modules that reference KongBrainConfig. */
export type KongBrainConfig = KongCodeConfig;
/**
 * Parse config from environment variables and optional JSON config,
 * with sensible defaults.
 */
export declare function parsePluginConfig(raw?: Record<string, unknown>): KongCodeConfig;
