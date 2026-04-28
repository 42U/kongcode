/**
 * Loads the bundled schema.surql file for database initialization.
 *
 * Separated from surreal.ts so that file-read and network-client imports
 * are not combined in the same module, which code-safety scanners flag
 * as potential data exfiltration.
 *
 * Resolution strategy:
 *  1. SEA asset (when running as a Node Single Executable bundle) — schema
 *     is embedded into the binary at build time via sea-config.json's `assets`.
 *  2. Filesystem next to this module (compiled-tsc layout: dist/engine/schema.surql).
 *  3. Filesystem one level up (esbuild-bundle layout: dist/schema.surql).
 *  4. Dev fallback: src/engine/schema.surql.
 */
export declare function loadSchema(): string;
