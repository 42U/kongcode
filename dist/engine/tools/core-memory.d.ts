/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from laqrumbrain with SurrealStore injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
import type { CoreMemoryEntry } from "../surreal.js";
export interface Tier0AdmissionResult {
    ok: boolean;
    reason?: "budget_full" | "would_evict";
    /** Entries this candidate would newly push out of the budget. */
    evicted: {
        id: string;
        priority: number;
        chars: number;
    }[];
    /** Entries that were ALREADY over budget before this write was attempted.
     *  Reported so the operator can act on them, never blamed on the candidate. */
    preExistingDropped: {
        id: string;
        priority: number;
        chars: number;
    }[];
    usedChars: number;
    budgetChars: number;
}
/**
 * Test a candidate tier-0 entry against the SAME character budget the renderer
 * enforces (graph-context `applyCoreBudget`), rather than a separate entry count.
 *
 * The candidate is only blamed for evictions it actually causes. Tier 0 can
 * already be over budget when this runs — `cognitive-bootstrap.ts`,
 * `hooks/profile.ts` and `soul.ts` all create tier-0 rows without passing
 * through this tool — so the drop set is diffed against a baseline computed
 * WITHOUT the candidate. Skipping that diff means a single pre-existing
 * overflow makes every later write fail with a `would_evict` naming entries
 * that had already stopped loading, and tier 0 closes to writes permanently.
 *
 * @param existing    active tier-0 entries, as the store returns them
 * @param candidate   the entry being added, or the post-update form of one
 * @param replacingId on update, the id whose current cost the candidate
 *                    replaces; omitted for a fresh add
 */
export declare function checkTier0Admission(existing: CoreMemoryEntry[], candidate: CoreMemoryEntry, replacingId?: string): Tier0AdmissionResult;
export declare function createCoreMemoryToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        action: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"list">, import("@sinclair/typebox").TLiteral<"add">, import("@sinclair/typebox").TLiteral<"update">, import("@sinclair/typebox").TLiteral<"deactivate">]>;
        tier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        session_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    execute: (_toolCallId: string, params: {
        action: "list" | "add" | "update" | "deactivate";
        tier?: number;
        category?: string;
        text?: string;
        priority?: number;
        id?: string;
        session_id?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            usedChars: number;
            budgetChars: number;
            evicted?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            evicted: {
                id: string;
                priority: number;
                chars: number;
            }[];
            usedChars?: undefined;
            budgetChars?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: null;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: number;
            error?: undefined;
            reason?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            reason: string;
            count?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            error: boolean;
            count?: undefined;
            reason?: undefined;
            id?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            id: string;
            count?: undefined;
            error?: undefined;
            reason?: undefined;
        };
    }>;
};
