/**
 * subagent_spawned / subagent_ended hooks — track spawned subagents in the graph.
 *
 * Creates `subagent` records and `spawned` edges (session → subagent).
 * Updates subagent records with outcome on completion.
 */
import type { GlobalPluginState } from "../state.js";
interface SubagentSpawnedEvent {
    runId: string;
    childSessionKey: string;
    agentId?: string;
    label?: string;
    requester?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string;
    };
    threadRequested?: boolean;
    mode?: string;
}
interface SubagentSpawnedContext {
    runId: string;
    childSessionKey: string;
    requesterSessionKey?: string;
}
interface SubagentEndedEvent {
    targetSessionKey: string;
    targetKind?: string;
    reason?: string;
    sendFarewell?: boolean;
    accountId?: string;
    runId: string;
    endedAt?: string;
    outcome?: string;
    error?: string;
}
interface SubagentEndedContext {
    runId: string;
    childSessionKey: string;
    requesterSessionKey?: string;
}
export declare function createSubagentSpawnedHandler(state: GlobalPluginState): (event: SubagentSpawnedEvent, ctx: SubagentSpawnedContext) => Promise<void>;
export declare function createSubagentEndedHandler(state: GlobalPluginState): (event: SubagentEndedEvent, ctx: SubagentEndedContext) => Promise<void>;
export {};
