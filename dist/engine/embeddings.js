import { existsSync } from "node:fs";
import { swallow } from "./errors.js";
import { log } from "./log.js";
/** BGE-M3 embedding service (1024-dim via GGUF) with an LRU cache of up to 512 entries. */
export class EmbeddingService {
    config;
    model = null;
    ctx = null;
    ready = false;
    /** LRU embedding cache keyed by text, capped at maxCacheSize entries. */
    cache = new Map();
    maxCacheSize = 512;
    // Init lifecycle telemetry. Captured here so the introspect probe can name
    // the failure reason instead of just reporting "isAvailable=false". Without
    // this, callers that swallow init() errors (mcp-server boot path) leave the
    // service silently unavailable with no breadcrumb.
    initStartedAt = null;
    initFinishedAt = null;
    initError = null;
    constructor(config) {
        this.config = config;
    }
    /** Initialize the embedding model. Returns true if freshly loaded, false if already ready. */
    async initialize() {
        if (this.ready)
            return false;
        this.initStartedAt = Date.now();
        this.initError = null;
        try {
            if (!existsSync(this.config.modelPath)) {
                throw new Error(`Embedding model not found at: ${this.config.modelPath}\n  Download BGE-M3 GGUF or set EMBED_MODEL_PATH`);
            }
            const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
            const llama = await getLlama({
                logLevel: LlamaLogLevel.error,
                logger: (level, message) => {
                    if (message.includes("missing newline token"))
                        return;
                    if (level === LlamaLogLevel.error)
                        log.error(`[llama] ${message}`);
                    else if (level === LlamaLogLevel.warn)
                        log.warn(`[llama] ${message}`);
                },
            });
            this.model = await llama.loadModel({ modelPath: this.config.modelPath });
            this.ctx = await this.model.createEmbeddingContext();
            this.ready = true;
            this.initFinishedAt = Date.now();
            return true;
        }
        catch (err) {
            this.initError = err instanceof Error ? err : new Error(String(err));
            this.initFinishedAt = Date.now();
            // Log loudly so anyone tailing MCP stderr sees it immediately, even if
            // the caller swallows the throw.
            log.error(`[embeddings] initialize() failed: ${this.initError.message}`);
            throw this.initError;
        }
    }
    /** Snapshot init state — used by introspect/memory_health probes to name failures. */
    getDiagnostics() {
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
    async embed(text) {
        if (!this.ready || !this.ctx)
            throw new Error("Embeddings not initialized");
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
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(text, vec);
        return vec;
    }
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        return Promise.all(texts.map(text => this.embed(text)));
    }
    isAvailable() {
        return this.ready;
    }
    async dispose() {
        try {
            await this.ctx?.dispose();
            await this.model?.dispose();
            this.ready = false;
            this.cache.clear();
        }
        catch (e) {
            swallow("embeddings:dispose", e);
        }
    }
}
