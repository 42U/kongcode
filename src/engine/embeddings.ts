import { existsSync } from "node:fs";
import type { EmbeddingConfig } from "./config.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

// Lazy-import node-llama-cpp to avoid top-level await issues with jiti.
// The actual import happens inside initialize() at runtime.
type LlamaEmbeddingContext = import("node-llama-cpp").LlamaEmbeddingContext;
type LlamaModel = import("node-llama-cpp").LlamaModel;

/** Snapshot of the embedding service's init state, surfaced via diagnostics. */
export interface EmbeddingDiagnostics {
  ready: boolean;
  modelPath: string;
  initStartedAt: number | null;
  initFinishedAt: number | null;
  initDurationMs: number | null;
  initError: { message: string; stack?: string } | null;
}

/** BGE-M3 embedding service (1024-dim via GGUF) with an LRU cache of up to 512 entries. */
export class EmbeddingService {
  private model: LlamaModel | null = null;
  private ctx: LlamaEmbeddingContext | null = null;
  private ready = false;
  /** LRU embedding cache keyed by text, capped at maxCacheSize entries. */
  private cache = new Map<string, number[]>();
  private readonly maxCacheSize = 512;
  // Init lifecycle telemetry. Captured here so the introspect probe can name
  // the failure reason instead of just reporting "isAvailable=false". Without
  // this, callers that swallow init() errors (mcp-server boot path) leave the
  // service silently unavailable with no breadcrumb.
  private initStartedAt: number | null = null;
  private initFinishedAt: number | null = null;
  private initError: Error | null = null;

  constructor(private readonly config: EmbeddingConfig) {}

  /** Initialize the embedding model. Returns true if freshly loaded, false if already ready. */
  async initialize(): Promise<boolean> {
    if (this.ready) return false;
    this.initStartedAt = Date.now();
    this.initError = null;
    try {
      if (!existsSync(this.config.modelPath)) {
        throw new Error(
          `Embedding model not found at: ${this.config.modelPath}\n  Download BGE-M3 GGUF or set EMBED_MODEL_PATH`,
        );
      }
      const { loadNodeLlamaCpp } = await import("./llama-loader.js");
      const { getLlama, LlamaLogLevel } = await loadNodeLlamaCpp();
      const llama = await getLlama({
        logLevel: LlamaLogLevel.error,
        logger: (level, message) => {
          if (message.includes("missing newline token")) return;
          if (level === LlamaLogLevel.error) log.error(`[llama] ${message}`);
          else if (level === LlamaLogLevel.warn) log.warn(`[llama] ${message}`);
        },
      });
      this.model = await llama.loadModel({ modelPath: this.config.modelPath });
      this.ctx = await this.model.createEmbeddingContext();
      this.ready = true;
      this.initFinishedAt = Date.now();
      return true;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      this.initFinishedAt = Date.now();
      // Log loudly so anyone tailing MCP stderr sees it immediately, even if
      // the caller swallows the throw.
      log.error(`[embeddings] initialize() failed: ${this.initError.message}`);
      throw this.initError;
    }
  }

  /** Snapshot init state — used by introspect/memory_health probes to name failures. */
  getDiagnostics(): EmbeddingDiagnostics {
    const start = this.initStartedAt;
    const end = this.initFinishedAt;
    return {
      ready: this.ready,
      modelPath: this.config.modelPath,
      initStartedAt: start,
      initFinishedAt: end,
      initDurationMs: start != null && end != null ? end - start : null,
      initError: this.initError
        ? { message: this.initError.message, stack: this.initError.stack }
        : null,
    };
  }

  /** Return the embedding vector for text, serving from LRU cache on repeat calls. */
  async embed(text: string): Promise<number[]> {
    if (!this.ready || !this.ctx) throw new Error("Embeddings not initialized");
    const cached = this.cache.get(text);
    if (cached) {
      // Move to end for LRU freshness
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }
    const result = await this.ctx.getEmbeddingFor(text);
    const vec = Array.from(result.vector);
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxCacheSize) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(text, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return Promise.all(texts.map(text => this.embed(text)));
  }

  isAvailable(): boolean {
    return this.ready;
  }

  async dispose(): Promise<void> {
    try {
      await this.ctx?.dispose();
      await this.model?.dispose();
      this.ready = false;
      this.cache.clear();
    } catch (e) {
      swallow("embeddings:dispose", e);
    }
  }
}
