import { chmodSync, createWriteStream, existsSync, readFileSync, statSync, } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { log } from "./log.js";
const execFileAsync = promisify(execFile);
let managedSurreal = null;
/** Resolve the plugin root from this file's compiled location (dist/engine/bootstrap.js).
 *
 *  Under SEA (CJS-in-binary), import.meta.url is undefined and fileURLToPath
 *  throws. Fall back to the directory containing the running executable —
 *  for SEA, that's wherever the user installed the plugin binary, which is
 *  the natural plugin root. KONGCODE_PLUGIN_DIR overrides explicitly.
 */
export function resolvePluginDir() {
    if (process.env.KONGCODE_PLUGIN_DIR)
        return process.env.KONGCODE_PLUGIN_DIR;
    try {
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        // bootstrap.js lives at <pluginDir>/dist/engine/, so go up two levels.
        return join(moduleDir, "..", "..");
    }
    catch {
        // SEA / CJS path: process.execPath is the SEA binary; its parent dir is
        // <pluginDir>/dist/bin/ in our layout, so the plugin root is two levels up.
        return join(dirname(process.execPath), "..", "..");
    }
}
function detectPlatformKey() {
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
    return `${process.platform}-${arch}`;
}
async function downloadFile(url, destPath, expectedSha256) {
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
    const body = res.body;
    for await (const chunk of body) {
        if (hasher)
            hasher.update(chunk);
        bytes += chunk.length;
        if (!writer.write(chunk)) {
            await new Promise((resolve) => writer.once("drain", () => resolve()));
        }
    }
    await new Promise((resolve, reject) => {
        writer.end((err) => (err ? reject(err) : resolve()));
    });
    if (hasher && expectedSha256) {
        const actual = hasher.digest("hex");
        if (actual !== expectedSha256) {
            await rm(tmpPath, { force: true });
            throw new Error(`sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
        }
    }
    await rename(tmpPath, destPath);
    return { sizeBytes: bytes };
}
async function ensureNpmDeps(pluginDir) {
    const nodeModules = join(pluginDir, "node_modules");
    if (existsSync(nodeModules)) {
        return { ran: false, durationMs: 0 };
    }
    // Skip when no package.json is adjacent — under SEA the binary stands alone
    // (deps are bundled inline + native pieces downloaded separately into the
    // cache), and KONGCODE_SKIP_NPM_CI is an explicit opt-out for advanced setups.
    if (!existsSync(join(pluginDir, "package.json"))) {
        return { ran: false, durationMs: 0 };
    }
    if (process.env.KONGCODE_SKIP_NPM_CI === "1") {
        return { ran: false, durationMs: 0 };
    }
    log.info(`[bootstrap] node_modules missing under ${pluginDir} — running 'npm ci --omit=dev' (one-time first-run cost, ~1-2 min)`);
    const start = Date.now();
    // Pass --prefix so we install into the plugin dir even if cwd is elsewhere.
    await execFileAsync("npm", ["ci", "--omit=dev", "--prefix", pluginDir], {
        env: { ...process.env, npm_config_yes: "true" },
        maxBuffer: 200 * 1024 * 1024, // npm output for native deps can be chatty
    });
    return { ran: true, durationMs: Date.now() - start };
}
async function ensureSurrealBinary(cacheDir, manifest, override) {
    if (override) {
        if (!existsSync(override)) {
            throw new Error(`SURREAL_BIN_PATH points to missing file: ${override}`);
        }
        return { path: override, provisioned: false, sizeBytes: statSync(override).size };
    }
    const platformKey = detectPlatformKey();
    const platform = manifest.surrealdb.platforms[platformKey];
    if (!platform) {
        throw new Error(`kongcode bootstrap does not have a SurrealDB binary mapping for platform "${platformKey}". ` +
            `Supported: ${Object.keys(manifest.surrealdb.platforms).join(", ")}. ` +
            `Workaround: install SurrealDB ${manifest.surrealdb.version} manually and set SURREAL_BIN_PATH, ` +
            `or point SURREAL_URL at an existing SurrealDB instance.`);
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
    log.info(`[bootstrap] Downloading SurrealDB ${manifest.surrealdb.version} for ${platformKey}: ${url}`);
    const archivePath = join(versionedDir, `surreal.${platform.ext}`);
    const dl = await downloadFile(url, archivePath, platform.sha256);
    if (platform.ext === "tgz" || platform.ext === "tar.gz") {
        await execFileAsync("tar", ["-xzf", archivePath, "-C", versionedDir]);
        await rm(archivePath, { force: true });
    }
    else {
        // Single-file binary (Windows .exe). Move into place under the expected name.
        await rename(archivePath, binPath);
    }
    if (!existsSync(binPath)) {
        throw new Error(`extraction did not produce expected binary at ${binPath}. archive may have a different layout.`);
    }
    if (process.platform !== "win32") {
        chmodSync(binPath, 0o755);
    }
    return { path: binPath, provisioned: true, sizeBytes: dl.sizeBytes };
}
/**
 * Download node-llama-cpp main package + matching platform binding into
 * <cacheDir>/native/ so SEA-built binaries (which have no adjacent
 * node_modules) can still resolve the dynamic import. Layout matches Node's
 * standard module resolution: the platform package goes under
 * <cacheDir>/native/node_modules/@node-llama-cpp/<platform>/ so when
 * node-llama-cpp's main code does require("@node-llama-cpp/<platform>"),
 * Node walks up from <cacheDir>/native/node-llama-cpp/dist/ and finds it.
 *
 * Sets KONGCODE_NODE_LLAMA_CPP_PATH to the absolute index.js path so
 * src/engine/llama-loader.ts imports from the right place.
 *
 * Skipped when running under standard Node + node_modules (the existing
 * "node-llama-cpp" specifier resolves naturally).
 */
async function ensureNodeLlamaCpp(cacheDir, manifest, pluginDir) {
    // Skip if node_modules has node-llama-cpp adjacent (npm-ci'd plugin install
    // or dev tree). Cheap existsSync — saves the manifest lookup + work.
    if (existsSync(join(pluginDir, "node_modules", "node-llama-cpp", "package.json"))) {
        return { mainPath: null, provisioned: false };
    }
    if (!manifest.nodeLlamaCpp) {
        return { mainPath: null, provisioned: false };
    }
    const platformKey = detectPlatformKey();
    const platformName = manifest.nodeLlamaCpp.platforms[platformKey];
    if (!platformName) {
        log.warn(`[bootstrap] node-llama-cpp: no platform mapping for ${platformKey} — embeddings will fail unless KONGCODE_NODE_LLAMA_CPP_PATH is set.`);
        return { mainPath: null, provisioned: false };
    }
    const version = manifest.nodeLlamaCpp.version;
    const nativeDir = join(cacheDir, "native");
    const mainDir = join(nativeDir, "node-llama-cpp");
    const mainEntry = join(mainDir, "dist", "index.js");
    const platformDir = join(nativeDir, "node_modules", "@node-llama-cpp", platformName);
    const platformEntry = join(platformDir, "package.json");
    // Idempotent: skip download if both already extracted.
    if (existsSync(mainEntry) && existsSync(platformEntry)) {
        process.env.KONGCODE_NODE_LLAMA_CPP_PATH = mainEntry;
        return { mainPath: mainEntry, provisioned: false };
    }
    const mainUrl = manifest.nodeLlamaCpp.mainTarballUrl.replaceAll("{version}", version);
    const platformUrl = manifest.nodeLlamaCpp.platformTarballUrl
        .replaceAll("{version}", version)
        .replaceAll("{platform}", platformName);
    log.info(`[bootstrap] Downloading node-llama-cpp ${version} (main + ${platformName} binding) for ${platformKey}`);
    const mainTarball = join(nativeDir, `node-llama-cpp-${version}.tgz`);
    const platformTarball = join(nativeDir, `${platformName}-${version}.tgz`);
    await downloadFile(mainUrl, mainTarball, null);
    await downloadFile(platformUrl, platformTarball, null);
    // npm tarballs wrap contents in a "package/" prefix; --strip-components=1
    // unwraps that so the package files land directly in mainDir / platformDir.
    await mkdir(mainDir, { recursive: true });
    await mkdir(platformDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", mainTarball, "-C", mainDir, "--strip-components=1"]);
    await execFileAsync("tar", ["-xzf", platformTarball, "-C", platformDir, "--strip-components=1"]);
    await rm(mainTarball, { force: true });
    await rm(platformTarball, { force: true });
    if (!existsSync(mainEntry)) {
        throw new Error(`node-llama-cpp tarball did not extract to expected path ${mainEntry}`);
    }
    process.env.KONGCODE_NODE_LLAMA_CPP_PATH = mainEntry;
    return { mainPath: mainEntry, provisioned: true };
}
async function ensureEmbeddingModel(modelPath, manifest) {
    if (existsSync(modelPath)) {
        return { path: modelPath, provisioned: false, sizeBytes: statSync(modelPath).size };
    }
    log.info(`[bootstrap] Downloading BGE-M3 embedding model (~420MB, one-time): ${manifest.embeddingModel.url}`);
    const dl = await downloadFile(manifest.embeddingModel.url, modelPath, manifest.embeddingModel.sha256);
    return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes };
}
async function spawnManagedSurreal(binPath, dataDir, port, user, pass) {
    await mkdir(dataDir, { recursive: true });
    // SurrealDB v3 syntax: `surreal start surrealkv:<absolute-path> --user X --pass Y --bind host:port`
    const child = spawn(binPath, [
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
    ], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
    child.on("exit", (code, signal) => {
        log.warn(`[surreal] managed child exited code=${code} signal=${signal}`);
    });
    return child;
}
async function waitForSurrealReady(port, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok)
                return;
        }
        catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`managed SurrealDB did not become ready on 127.0.0.1:${port} within ${timeoutMs}ms` +
        (lastErr ? ` (last error: ${lastErr.message})` : ""));
}
function loadManifest(pluginDir) {
    const path = join(pluginDir, "bin-manifest.json");
    return JSON.parse(readFileSync(path, "utf-8"));
}
function pickPort() {
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
export async function bootstrap(input) {
    const start = Date.now();
    const manifest = loadManifest(input.pluginDir);
    const npmInstall = await ensureNpmDeps(input.pluginDir);
    const nodeLlamaCpp = await ensureNodeLlamaCpp(input.cacheDir, manifest, input.pluginDir);
    const embeddingModel = await ensureEmbeddingModel(input.modelPath, manifest);
    // External-SurrealDB path: user explicitly opted out via SURREAL_URL.
    if (input.surrealUrlOverride) {
        log.info(`[bootstrap] SURREAL_URL set to ${input.surrealUrlOverride} — skipping managed SurrealDB child.`);
        return {
            npmInstall,
            surrealBinary: { path: "(external)", provisioned: false, sizeBytes: 0 },
            surrealServer: {
                url: input.surrealUrlOverride,
                pid: null,
                managed: false,
            },
            embeddingModel,
            nodeLlamaCpp,
            totalDurationMs: Date.now() - start,
        };
    }
    const surrealBinary = await ensureSurrealBinary(input.cacheDir, manifest, input.surrealBinPathOverride);
    const port = pickPort();
    managedSurreal = await spawnManagedSurreal(surrealBinary.path, input.dataDir, port, input.surrealUser, input.surrealPass);
    await waitForSurrealReady(port);
    const url = `ws://127.0.0.1:${port}/rpc`;
    log.info(`[bootstrap] managed SurrealDB ready on ${url} (pid=${managedSurreal.pid})`);
    return {
        npmInstall,
        surrealBinary,
        surrealServer: { url, pid: managedSurreal.pid ?? null, managed: true },
        embeddingModel,
        nodeLlamaCpp,
        totalDurationMs: Date.now() - start,
    };
}
/** SIGTERM the managed SurrealDB child if we spawned one. Idempotent. */
export function shutdownManagedSurreal() {
    if (managedSurreal && !managedSurreal.killed) {
        log.info(`[bootstrap] SIGTERM managed SurrealDB child pid=${managedSurreal.pid}`);
        try {
            managedSurreal.kill("SIGTERM");
        }
        catch (e) {
            log.warn(`[bootstrap] failed to SIGTERM child: ${e.message}`);
        }
        managedSurreal = null;
    }
}
