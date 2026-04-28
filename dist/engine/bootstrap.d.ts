export interface BootstrapResult {
    npmInstall: {
        ran: boolean;
        durationMs: number;
    };
    surrealBinary: {
        path: string;
        provisioned: boolean;
        sizeBytes: number;
    };
    surrealServer: {
        url: string;
        pid: number | null;
        managed: boolean;
    };
    embeddingModel: {
        path: string;
        provisioned: boolean;
        sizeBytes: number;
    };
    nodeLlamaCpp: {
        mainPath: string | null;
        provisioned: boolean;
    };
    ajv: {
        provisioned: boolean;
        nodeModulesDir: string | null;
    };
    totalDurationMs: number;
}
export interface BootstrapInput {
    pluginDir: string;
    cacheDir: string;
    dataDir: string;
    modelPath: string;
    surrealBinPathOverride: string | null;
    surrealUrlOverride: string | undefined;
    surrealUser: string;
    surrealPass: string;
}
/** Resolve the plugin root from this file's compiled location (dist/engine/bootstrap.js).
 *
 *  Under SEA (CJS-in-binary), import.meta.url is undefined and fileURLToPath
 *  throws. Fall back to the directory containing the running executable —
 *  for SEA, that's wherever the user installed the plugin binary, which is
 *  the natural plugin root. KONGCODE_PLUGIN_DIR overrides explicitly.
 */
export declare function resolvePluginDir(): string;
/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when KONGCODE_SKIP_BOOTSTRAP=1 is set.
 * Skips the SurrealDB child when SURREAL_URL points at an external server.
 */
export declare function bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
/** Per Option A architecture: the surreal child is detached + unref'd on spawn,
 *  so MCP exit does not affect its lifecycle. By default this function is a
 *  no-op — calling it during MCP shutdown leaves the surreal child running so
 *  the next MCP boot can attach to it (preserving turn-ingestion across
 *  plugin updates, Claude Code restarts, etc.).
 *
 *  Pass { force: true } to actually SIGTERM the child — used by tests and any
 *  future "kongcode stop" CLI command that explicitly tears everything down. */
export declare function shutdownManagedSurreal(opts?: {
    force?: boolean;
}): void;
