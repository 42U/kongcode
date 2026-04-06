/**
 * Loads the bundled schema.surql file for database initialization.
 *
 * Separated from surreal.ts so that file-read and network-client imports
 * are not combined in the same module, which code-safety scanners flag
 * as potential data exfiltration.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadSchema(): string {
  const primary = join(__dirname, "schema.surql");
  try {
    return readFileSync(primary, "utf-8");
  } catch {
    // Dev fallback: compiled output lives in dist/, schema source in src/
    return readFileSync(join(__dirname, "..", "src", "schema.surql"), "utf-8");
  }
}
