export interface HandoffFileData {
    sessionId: string;
    timestamp: string;
    userTurnCount: number;
    lastUserText: string;
    lastAssistantText: string;
    unextractedTokens: number;
}
/**
 * Synchronously write a handoff file. Safe to call from process.on("exit").
 */
export declare function writeHandoffFileSync(data: HandoffFileData, workspaceDir: string): void;
/**
 * Read and delete the handoff file. Returns null if not found.
 */
export declare function readAndDeleteHandoffFile(workspaceDir: string): HandoffFileData | null;
