import {
  chmodSync,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

interface PlatformEntry {
  platform: string;
  ext: string;
  binaryName: string;
  sha256: string | null;
}

interface Manifest {
  surrealdb: {
    version: string;
    releaseUrl: string;
    platforms: Record<string, PlatformEntry>;
  };
  embeddingModel: {
    name: string;
    url: string;
    sha256: string | null;
  };
}

export interface BootstrapResult {
  npmInstall: { ran: boolean; durationMs: number };
  surrealBinary: { path: string; provisioned: boolean; sizeBytes: number };
  surrealServer: { url: string; pid: number | null; managed: boolean };
  embeddingModel: { path: string; provisioned: boolean; sizeBytes: number };
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

let managedSurreal: ChildProcess | null = null;

/** Resolve the plugin root from this file's compiled location (dist/engine/bootstrap.js). */
export function resolvePluginDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // bootstrap.js lives at <pluginDir>/dist/engine/, so go up two levels.
  return join(moduleDir, "..", "..");
}

function detectPlatformKey(): string {
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${process.platform}-${arch}`;
}

async function downloadFile(
  url: string,
  destPath: string,
  expectedSha256: string | null,
): Promise<{ sizeBytes: number }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.body) {
    throw new Error(`download returned empty body: ${url}`);
  }

  await mkdir(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;
  const writer = createWriteStream(tmpPath);
  let bytes = 0;
  const hasher = expectedSha256 ? createHash("sha256") : null;

  // Node's fetch returns a web ReadableStream; iterate it as bytes.
  // ReadableStream is async-iterable in Node 18+; cast through unknown.
  const body = res.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    if (hasher) hasher.update(chunk);
    bytes += chunk.length;
    if (!writer.write(chunk)) {
      await new Promise<void>((resolve) => writer.once("drain", () => resolve()));
    }
  }
  await new Promise<void>((resolve, reject) => {
    writer.end((err: unknown) => (err ? reject(err) : resolve()));
  });

  if (hasher && expectedSha256) {
    const actual = hasher.digest("hex");
    if (actual !== expectedSha256) {
      await rm(tmpPath, { force: true });
      throw new Error(
        `sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }

  await rename(tmpPath, destPath);
  return { sizeBytes: bytes };
}

async function ensureNpmDeps(
  pluginDir: string,
): Promise<{ ran: boolean; durationMs: number }> {
  const nodeModules = join(pluginDir, "node_modules");
  if (existsSync(nodeModules)) {
    return { ran: false, durationMs: 0 };
  }
  log.info(
    `[bootstrap] node_modules missing under ${pluginDir} — running 'npm ci --omit=dev' (one-time first-run cost, ~1-2 min)`,
  );
  const start = Date.now();
  // Pass --prefix so we install into the plugin dir even if cwd is elsewhere.
  await execFileAsync("npm", ["ci", "--omit=dev", "--prefix", pluginDir], {
    env: { ...process.env, npm_config_yes: "true" },
    maxBuffer: 200 * 1024 * 1024, // npm output for native deps can be chatty
  });
  return { ran: true, durationMs: Date.now() - start };
}

async function ensureSurrealBinary(
  cacheDir: string,
  manifest: Manifest,
  override: string | null,
): Promise<{ path: string; provisioned: boolean; sizeBytes: number }> {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`SURREAL_BIN_PATH points to missing file: ${override}`);
    }
    return { path: override, provisioned: false, sizeBytes: statSync(override).size };
  }
  const platformKey = detectPlatformKey();
  const platform = manifest.surrealdb.platforms[platformKey];
  if (!platform) {
    throw new Error(
      `kongcode bootstrap does not have a SurrealDB binary mapping for platform "${platformKey}". ` +
        `Supported: ${Object.keys(manifest.surrealdb.platforms).join(", ")}. ` +
        `Workaround: install SurrealDB ${manifest.surrealdb.version} manually and set SURREAL_BIN_PATH, ` +
        `or point SURREAL_URL at an existing SurrealDB instance.`,
    );
  }
  const versionedDir = join(cacheDir, `surreal-${manifest.surrealdb.version}`);
  const binPath = join(versionedDir, platform.binaryName);
  if (existsSync(binPath)) {
    return { path: binPath, provisioned: false, sizeBytes: statSync(binPath).size };
  }
  const url = manifest.surrealdb.releaseUrl
    .replaceAll("{version}", manifest.surrealdb.version)
    .replaceAll("{platform}", platform.platform)
    .replaceAll("{ext}", platform.ext);
  log.info(
    `[bootstrap] Downloading SurrealDB ${manifest.surrealdb.version} for ${platformKey}: ${url}`,
  );
  const archivePath = join(versionedDir, `surreal.${platform.ext}`);
  const dl = await downloadFile(url, archivePath, platform.sha256);

  if (platform.ext === "tgz" || platform.ext === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", versionedDir]);
    await rm(archivePath, { force: true });
  } else {
    // Single-file binary (Windows .exe). Move into place under the expected name.
    await rename(archivePath, binPath);
  }
  if (!existsSync(binPath)) {
    throw new Error(
      `extraction did not produce expected binary at ${binPath}. archive may have a different layout.`,
    );
  }
  if (process.platform !== "win32") {
    chmodSync(binPath, 0o755);
  }
  return { path: binPath, provisioned: true, sizeBytes: dl.sizeBytes };
}

async function ensureEmbeddingModel(
  modelPath: string,
  manifest: Manifest,
): Promise<{ path: string; provisioned: boolean; sizeBytes: number }> {
  if (existsSync(modelPath)) {
    return { path: modelPath, provisioned: false, sizeBytes: statSync(modelPath).size };
  }
  log.info(
    `[bootstrap] Downloading BGE-M3 embedding model (~420MB, one-time): ${manifest.embeddingModel.url}`,
  );
  const dl = await downloadFile(
    manifest.embeddingModel.url,
    modelPath,
    manifest.embeddingModel.sha256,
  );
  return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes };
}

async function spawnManagedSurreal(
  binPath: string,
  dataDir: string,
  port: number,
  user: string,
  pass: string,
): Promise<ChildProcess> {
  await mkdir(dataDir, { recursive: true });
  // SurrealDB v3 syntax: `surreal start surrealkv:<absolute-path> --user X --pass Y --bind host:port`
  const child = spawn(
    binPath,
    [
      "start",
      `surrealkv:${dataDir}`,
      "--user",
      user,
      "--pass",
      pass,
      "--bind",
      `127.0.0.1:${port}`,
      "--log",
      "warn",
    ],
    {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
  child.stderr?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
  child.on("exit", (code, signal) => {
    log.warn(`[surreal] managed child exited code=${code} signal=${signal}`);
  });
  return child;
}

async function waitForSurrealReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `managed SurrealDB did not become ready on 127.0.0.1:${port} within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : ""),
  );
}

function loadManifest(pluginDir: string): Manifest {
  const path = join(pluginDir, "bin-manifest.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function pickPort(): number {
  const env = Number(process.env.KONGCODE_SURREAL_PORT);
  return Number.isFinite(env) && env > 0 ? env : 18765;
}

/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when KONGCODE_SKIP_BOOTSTRAP=1 is set.
 * Skips the SurrealDB child when SURREAL_URL points at an external server.
 */
export async function bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
  const start = Date.now();
  const manifest = loadManifest(input.pluginDir);

  const npmInstall = await ensureNpmDeps(input.pluginDir);
  const embeddingModel = await ensureEmbeddingModel(input.modelPath, manifest);

  // External-SurrealDB path: user explicitly opted out via SURREAL_URL.
  if (input.surrealUrlOverride) {
    log.info(
      `[bootstrap] SURREAL_URL set to ${input.surrealUrlOverride} — skipping managed SurrealDB child.`,
    );
    return {
      npmInstall,
      surrealBinary: { path: "(external)", provisioned: false, sizeBytes: 0 },
      surrealServer: {
        url: input.surrealUrlOverride,
        pid: null,
        managed: false,
      },
      embeddingModel,
      totalDurationMs: Date.now() - start,
    };
  }

  const surrealBinary = await ensureSurrealBinary(
    input.cacheDir,
    manifest,
    input.surrealBinPathOverride,
  );
  const port = pickPort();
  managedSurreal = await spawnManagedSurreal(
    surrealBinary.path,
    input.dataDir,
    port,
    input.surrealUser,
    input.surrealPass,
  );
  await waitForSurrealReady(port);
  const url = `ws://127.0.0.1:${port}/rpc`;
  log.info(`[bootstrap] managed SurrealDB ready on ${url} (pid=${managedSurreal.pid})`);

  return {
    npmInstall,
    surrealBinary,
    surrealServer: { url, pid: managedSurreal.pid ?? null, managed: true },
    embeddingModel,
    totalDurationMs: Date.now() - start,
  };
}

/** SIGTERM the managed SurrealDB child if we spawned one. Idempotent. */
export function shutdownManagedSurreal(): void {
  if (managedSurreal && !managedSurreal.killed) {
    log.info(`[bootstrap] SIGTERM managed SurrealDB child pid=${managedSurreal.pid}`);
    try {
      managedSurreal.kill("SIGTERM");
    } catch (e) {
      log.warn(`[bootstrap] failed to SIGTERM child: ${(e as Error).message}`);
    }
    managedSurreal = null;
  }
}
