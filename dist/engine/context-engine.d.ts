/**
 * KongCode Context Engine — core lifecycle methods.
 *
 * Preserves the KongBrain context engine logic (bootstrap, assemble, ingest,
 * compact, afterTurn) but removes the OpenClaw ContextEngine interface dependency.
 * These methods are called by hook handlers in the MCP server.
 */
import type { AgentMessage } from "./types.js";
type AssembleResult = {
    messages: AgentMessage[];
    estimatedTokens: number;
    systemPromptAddition?: string;
};
type BootstrapResult = {
    bootstrapped: boolean;
    importedMessages?: number;
    reason?: string;
};
type CompactResult = {
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
        summary?: string;
        firstKeptEntryId?: string;
        tokensBefore: number;
        tokensAfter?: number;
        details?: unknown;
    };
};
type IngestResult = {
    ingested: boolean;
};
type IngestBatchResult = {
    ingestedCount: number;
};
import type { GlobalPluginState } from "./state.js";
/** Context engine backed by SurrealDB graph retrieval and BGE-M3 embeddings. */
export declare class KongCodeContextEngine {
    private readonly state;
    readonly info: {
        id: string;
        name: string;
        version: string;
        ownsCompaction: boolean;
    };
    constructor(state: GlobalPluginState);
    /** Initialize schema, create 5-pillar graph nodes, and start the memory daemon. */
    bootstrap(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
    }): Promise<BootstrapResult>;
    /** Build the context window: graph retrieval + system prompt additions + budget trimming. */
    assemble(params: {
        sessionId: string;
        sessionKey?: string;
        messages: AgentMessage[];
        tokenBudget?: number;
        model?: string;
        prompt?: string;
    }): Promise<AssembleResult>;
    /** Embed and store a single user or assistant message as a turn node. */
    ingest(params: {
        sessionId: string;
        sessionKey?: string;
        message: AgentMessage;
        isHeartbeat?: boolean;
    }): Promise<IngestResult>;
    ingestBatch?(params: {
        sessionId: string;
        sessionKey?: string;
        messages: AgentMessage[];
        isHeartbeat?: boolean;
    }): Promise<IngestBatchResult>;
    /** Extract structured signals (pending work, key files, errors) for post-compaction injection. */
    compact(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
    }): Promise<CompactResult>;
    /** Post-turn: ingest messages, evaluate retrieval quality, flush daemon, and run periodic maintenance. */
    afterTurn?(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        messages: AgentMessage[];
        prePromptMessageCount: number;
    }): Promise<void>;
    dispose(): Promise<void>;
}
export {};
