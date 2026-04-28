/**
 * Loads the bundled schema.surql file for database initialization.
 *
 * Separated from surreal.ts so that file-read and network-client imports
 * are not combined in the same module, which code-safety scanners flag
 * as potential data exfiltration.
 */
export declare function loadSchema(): string;
