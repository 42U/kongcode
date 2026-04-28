/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
export declare function createIntrospectToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        action: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"status">, import("@sinclair/typebox").TLiteral<"count">, import("@sinclair/typebox").TLiteral<"verify">, import("@sinclair/typebox").TLiteral<"query">, import("@sinclair/typebox").TLiteral<"migrate">, import("@sinclair/typebox").TLiteral<"trends">]>;
        table: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        filter: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        record_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    execute: (_toolCallId: string, params: {
        action: "status" | "count" | "verify" | "query" | "migrate" | "trends";
        table?: string;
        filter?: string;
        record_id?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            counts: Record<string, number>;
            embCounts: Record<string, number>;
            alive: any;
            totalNodes: number;
            totalEmb: number;
            embeddings: {
                status: "ok" | "down" | "degraded";
                label: string;
            };
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
            table: string;
            count: any;
            filter: string | undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            exists: boolean;
            id?: undefined;
            record?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            exists: boolean;
            id: string;
            record: Record<string, unknown>;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../workspace-migrate.js").MigrationResult;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../observability.js").TrendReport;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            templates: string[];
            count?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: any;
            templates?: undefined;
        };
    }>;
};
