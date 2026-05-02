export type ResourceTier = "constrained" | "standard" | "generous";
export interface ResourceProfile {
    tier: ResourceTier;
    totalRamMb: number;
    cpuCount: number;
    llamaMaxThreads: number;
    llamaGpu: false | "auto";
    idleTimeoutMs: number;
    drainIntervalMs: number;
}
export declare function detectResourceProfile(): ResourceProfile;
