/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from laqrumbrain with SurrealStore injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
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
            usedChars?: undefined;
            budgetChars?: undefined;
            evicted?: undefined;
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
            usedChars?: undefined;
            budgetChars?: undefined;
            evicted?: undefined;
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
            usedChars: number;
            budgetChars: number;
            count?: undefined;
            evicted?: undefined;
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
            evicted: {
                id: string;
                priority: number;
                chars: number;
            }[];
            count?: undefined;
            usedChars?: undefined;
            budgetChars?: undefined;
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
            usedChars?: undefined;
            budgetChars?: undefined;
            evicted?: undefined;
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
            usedChars?: undefined;
            budgetChars?: undefined;
            evicted?: undefined;
        };
    }>;
};
