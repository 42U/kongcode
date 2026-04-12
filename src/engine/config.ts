import { homedir } from "node:os";
import { join } from "node:path";

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

export interface KongCodeConfig {
  surreal: SurrealConfig;
  embedding: EmbeddingConfig;
  thresholds: ThresholdConfig;
}

/** @deprecated Alias for backwards compatibility with engine modules that reference KongBrainConfig. */
export type KongBrainConfig = KongCodeConfig;

/**
 * Parse config from environment variables and optional JSON config,
 * with sensible defaults.
 */
export function parsePluginConfig(raw?: Record<string, unknown>): KongCodeConfig {
  const surreal = (raw?.surreal ?? {}) as Record<string, unknown>;
  const embedding = (raw?.embedding ?? {}) as Record<string, unknown>;
  const thresholds = (raw?.thresholds ?? {}) as Record<string, unknown>;

  // Priority: plugin config > env vars > defaults
  // Use || (not ??) so empty strings from unresolved ${VAR} fall through to defaults
  const url =
    (typeof surreal.url === "string" && surreal.url ? surreal.url : null) ??
    (process.env.SURREAL_URL || null) ??
    "ws://localhost:8000/rpc";

  return {
    surreal: {
      url,
      get httpUrl() {
        const override = (typeof surreal.httpUrl === "string" && surreal.httpUrl ? surreal.httpUrl : null) ??
          (process.env.SURREAL_HTTP_URL || null);
        if (override) return override;
        return this.url
          .replace("ws://", "http://")
          .replace("wss://", "https://")
          .replace("/rpc", "/sql");
      },
      user: (typeof surreal.user === "string" && surreal.user ? surreal.user : null) ?? (process.env.SURREAL_USER || null) ?? "root",
      pass: (typeof surreal.pass === "string" && surreal.pass ? surreal.pass : null) ?? (process.env.SURREAL_PASS || null) ?? "root",
      ns: (typeof surreal.ns === "string" && surreal.ns ? surreal.ns : null) ?? (process.env.SURREAL_NS || null) ?? "kong",
      db: (typeof surreal.db === "string" && surreal.db ? surreal.db : null) ?? (process.env.SURREAL_DB || null) ?? "memory",
    },
    embedding: {
      modelPath:
        process.env.EMBED_MODEL_PATH ??
        (typeof embedding.modelPath === "string"
          ? embedding.modelPath
          : join(homedir(), ".node-llama-cpp", "models", "bge-m3-q4_k_m.gguf")),
      dimensions:
        typeof embedding.dimensions === "number" ? embedding.dimensions : 1024,
    },
    thresholds: {
      daemonTokenThreshold:
        typeof thresholds.daemonTokenThreshold === "number" ? thresholds.daemonTokenThreshold : 4000,
      midSessionCleanupThreshold:
        typeof thresholds.midSessionCleanupThreshold === "number" ? thresholds.midSessionCleanupThreshold : 25_000,
      extractionTimeoutMs:
        typeof thresholds.extractionTimeoutMs === "number" ? thresholds.extractionTimeoutMs : 60_000,
      maxPendingThinking:
        typeof thresholds.maxPendingThinking === "number" ? thresholds.maxPendingThinking : 20,
      acanTrainingThreshold:
        typeof thresholds.acanTrainingThreshold === "number" ? thresholds.acanTrainingThreshold : 5000,
    },
  };
}
