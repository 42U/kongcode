/**
 * Phase 3 — external-target credential chain.
 *
 * Pre-Phase-3, external SurrealDB targets (docker on 8000, SURREAL_URL) were
 * probed and connected with the configured creds, which collapse to the
 * legacy root:root DEFAULT when nothing is configured. Hardening the
 * instance (rotating root) then made discovery's auth fail, which is
 * indistinguishable from "not a laqrumcode DB" — and a failed discovery
 * falls through to a FRESH managed spawn: split-brain.
 *
 * The chain: explicit config verbatim; otherwise the managed per-user cred
 * file first, legacy root:root last. Discovery tries the chain per
 * candidate URL and the winning credential propagates to the connection
 * config (daemon and mcp-server both adopt surrealServer.user/pass).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExternalCredChain,
  readManagedCred,
  findExistingLaqrumcodeSurreal,
} from "../src/engine/bootstrap.js";
import { parsePluginConfig } from "../src/engine/config.js";

function tmpCacheDir(): { root: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lc-credchain-"));
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  return { root, cacheDir };
}

describe("buildExternalCredChain", () => {
  const configured = { user: "root", pass: "root" };
  const fileCred = { user: "laqrum_1000", pass: "secret" };

  it("explicit config short-circuits to exactly [configured]", () => {
    expect(buildExternalCredChain({ credsExplicit: true, configured, fileCred }))
      .toEqual([configured]);
  });

  it("non-explicit prefers the managed cred file, root:root last", () => {
    expect(buildExternalCredChain({ credsExplicit: false, configured, fileCred }))
      .toEqual([fileCred, configured]);
  });

  it("non-explicit without a cred file is just the legacy default", () => {
    expect(buildExternalCredChain({ credsExplicit: false, configured, fileCred: null }))
      .toEqual([configured]);
  });
});

describe("readManagedCred (read-only)", () => {
  it("returns null when the file is absent — and never creates one", () => {
    const { root, cacheDir } = tmpCacheDir();
    try {
      expect(readManagedCred(cacheDir)).toBeNull();
      // Merely considering the fallback must not mint a credential.
      expect(readManagedCred(cacheDir)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("parses a valid cred file", () => {
    const { root, cacheDir } = tmpCacheDir();
    try {
      writeFileSync(join(root, "surreal-cred.json"), JSON.stringify({ user: "laqrum_7", pass: "p" }));
      expect(readManagedCred(cacheDir)).toEqual({ user: "laqrum_7", pass: "p" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns null for a malformed file", () => {
    const { root, cacheDir } = tmpCacheDir();
    try {
      writeFileSync(join(root, "surreal-cred.json"), "{not json");
      expect(readManagedCred(cacheDir)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("parsePluginConfig credsExplicit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("false when nothing is configured (legacy defaults)", () => {
    vi.stubEnv("SURREAL_USER", "");
    vi.stubEnv("SURREAL_PASS", "");
    const cfg = parsePluginConfig();
    expect(cfg.surreal.user).toBe("root");
    expect(cfg.surreal.credsExplicit).toBe(false);
  });

  it("true when SURREAL_USER env is set", () => {
    vi.stubEnv("SURREAL_USER", "opsuser");
    vi.stubEnv("SURREAL_PASS", "");
    const cfg = parsePluginConfig();
    expect(cfg.surreal.user).toBe("opsuser");
    expect(cfg.surreal.credsExplicit).toBe(true);
  });

  it("true when plugin config provides creds", () => {
    vi.stubEnv("SURREAL_USER", "");
    vi.stubEnv("SURREAL_PASS", "");
    const cfg = parsePluginConfig({ surreal: { user: "cfg", pass: "p" } });
    expect(cfg.surreal.credsExplicit).toBe(true);
  });
});

describe("findExistingLaqrumcodeSurreal credential chain", () => {
  const ourUid = typeof process.getuid === "function" ? process.getuid()! : 0;

  /** fetch stub: health OK only on port 8000; /sql fingerprints succeed only
   *  for the credential whose base64 Authorization matches `goodAuth`. */
  function stubFetch(goodUser: string, goodPass: string) {
    const goodAuth = "Basic " + Buffer.from(`${goodUser}:${goodPass}`).toString("base64");
    const attempts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/health")) {
        return { ok: u.includes(":8000/") } as Response;
      }
      if (u.includes("/sql")) {
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
        attempts.push(decoded.split(":")[0]);
        if (auth !== goodAuth) return { ok: false, status: 401 } as Response;
        return {
          ok: true,
          json: async () => [{ result: { tables: { monologue: {} } } }],
        } as unknown as Response;
      }
      return { ok: false } as Response;
    }));
    return attempts;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tries the chain in order and returns the winning credential", async () => {
    const { root, cacheDir } = tmpCacheDir();
    const attempts = stubFetch("root", "root"); // only legacy default auths
    try {
      const chain = [
        { user: "laqrum_1000", pass: "filecred" },
        { user: "root", pass: "root" },
      ];
      const found = await findExistingLaqrumcodeSurreal(
        cacheDir, 19999, "root", "root",
        () => ourUid, // owner guard: it's our instance
        chain,
      );
      expect(found).not.toBeNull();
      expect(found!.port).toBe(8000);
      expect(found!.pid).toBeNull(); // external — lifecycle not ours
      expect(found!.user).toBe("root");
      expect(found!.pass).toBe("root");
      expect(attempts).toEqual(["laqrum_1000", "root"]); // file cred tried FIRST
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("the managed cred wins when the instance knows it (hardened instance)", async () => {
    const { root, cacheDir } = tmpCacheDir();
    const attempts = stubFetch("laqrum_1000", "filecred"); // root:root rotated away
    try {
      const chain = [
        { user: "laqrum_1000", pass: "filecred" },
        { user: "root", pass: "root" },
      ];
      const found = await findExistingLaqrumcodeSurreal(
        cacheDir, 19999, "root", "root",
        () => ourUid,
        chain,
      );
      expect(found).not.toBeNull();
      expect(found!.user).toBe("laqrum_1000");
      expect(found!.pass).toBe("filecred");
      expect(attempts).toEqual(["laqrum_1000"]); // first candidate won; no root attempt
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("without a chain, behavior is exactly pre-Phase-3 (single configured cred)", async () => {
    const { root, cacheDir } = tmpCacheDir();
    const attempts = stubFetch("root", "root");
    try {
      const found = await findExistingLaqrumcodeSurreal(
        cacheDir, 19999, "root", "root",
        () => ourUid,
      );
      expect(found).not.toBeNull();
      expect(found!.user).toBe("root");
      expect(attempts).toEqual(["root"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("no authenticating credential → port skipped (no false adoption)", async () => {
    const { root, cacheDir } = tmpCacheDir();
    stubFetch("someone", "else"); // nothing in the chain matches
    try {
      const found = await findExistingLaqrumcodeSurreal(
        cacheDir, 19999, "root", "root",
        () => ourUid,
        [{ user: "laqrum_1000", pass: "filecred" }, { user: "root", pass: "root" }],
      );
      expect(found).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
