/**
 * LAQ-SEC-001 / LAQ-SEC-006 regression tests (2026-08-16 security audit).
 *
 * 001 — the UI launch flow exposed the MASTER hook-API token via the opener's
 * argv (/proc-visible on multi-user hosts), terminal output, and browser
 * history, because /ui/auth accepted the master token as a GET query param.
 * Now: the launcher POSTs /ui/mint (Bearer master) for a SINGLE-USE 60s
 * nonce; /ui/auth accepts ONLY nonces.
 *
 * 006 — DNS-rebinding defense-in-depth: both loopback HTTP surfaces reject
 * non-loopback Host headers before any auth handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackHost } from "../src/shared/net.js";
import { uiRequestHandler, _resetAuthNonces } from "../src/ui-server.js";

// ── isLoopbackHost (LAQ-SEC-006 policy) ─────────────────────────────────────

describe("isLoopbackHost", () => {
  const allowed = [
    undefined, "", "127.0.0.1", "127.0.0.1:33000", "127.1.2.3:8080",
    "localhost", "localhost:33000", "LOCALHOST:9", "[::1]", "[::1]:33000", "::1",
  ];
  const rejected = [
    "evil.example", "evil.example:33000", "127.0.0.1.evil.example",
    "localhost.evil.example", "0.0.0.0", "192.168.1.10:33000", "[::2]:33000",
    "127.0.0.1:33000.evil.example",
  ];
  for (const h of allowed) {
    it(`allows ${JSON.stringify(h)}`, () => expect(isLoopbackHost(h)).toBe(true));
  }
  for (const h of rejected) {
    it(`rejects ${JSON.stringify(h)}`, () => expect(isLoopbackHost(h)).toBe(false));
  }
});

// ── uiRequestHandler security envelope ──────────────────────────────────────

const TOKEN = "t".repeat(48);

interface Captured { status: number; headers: Record<string, unknown>; body: string; }

function drive(handler: ReturnType<typeof uiRequestHandler>, opts: {
  url: string; method?: string; headers?: Record<string, string>;
}): Captured {
  const cap: Captured = { status: 0, headers: {}, body: "" };
  const req = {
    url: opts.url,
    method: opts.method ?? "GET",
    headers: { host: "127.0.0.1:33000", ...(opts.headers ?? {}) },
  } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) { cap.status = status; cap.headers = headers ?? {}; return this; },
    end(body?: unknown) { cap.body = body === undefined ? "" : String(body); },
  } as unknown as ServerResponse;
  handler(req, res);
  return cap;
}

describe("uiRequestHandler — LAQ-SEC-001 mint-nonce flow", () => {
  let handler: ReturnType<typeof uiRequestHandler>;

  beforeEach(() => {
    _resetAuthNonces();
    handler = uiRequestHandler({} as never, TOKEN);
  });

  it("REJECTS the master token on /ui/auth (the leaked-URL vector is closed)", () => {
    const cap = drive(handler, { url: `/ui/auth?token=${TOKEN}` });
    expect(cap.status).toBe(401);
  });

  it("mint requires Bearer auth", () => {
    const cap = drive(handler, { url: "/ui/mint", method: "POST" });
    expect(cap.status).toBe(401);
  });

  it("mint is POST-only", () => {
    const cap = drive(handler, { url: "/ui/mint", method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(cap.status).toBe(405);
  });

  it("mint → auth sets the cookie exactly once (single-use nonce)", () => {
    const mint = drive(handler, { url: "/ui/mint", method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(mint.status).toBe(200);
    const { nonce } = JSON.parse(mint.body);
    expect(nonce).toMatch(/^[0-9a-f]{48}$/);

    const first = drive(handler, { url: `/ui/auth?nonce=${nonce}` });
    expect(first.status).toBe(302);
    expect(String(first.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(first.headers["set-cookie"])).toContain("SameSite=Strict");

    const replay = drive(handler, { url: `/ui/auth?nonce=${nonce}` });
    expect(replay.status).toBe(401); // consumed — replays are dead
  });

  it("an unminted nonce never authenticates", () => {
    const cap = drive(handler, { url: `/ui/auth?nonce=${"a".repeat(48)}` });
    expect(cap.status).toBe(401);
  });

  it("nonces expire after the TTL", () => {
    vi.useFakeTimers();
    try {
      const mint = drive(handler, { url: "/ui/mint", method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      const { nonce, ttl_ms } = JSON.parse(mint.body);
      vi.advanceTimersByTime(ttl_ms + 1000);
      const cap = drive(handler, { url: `/ui/auth?nonce=${nonce}` });
      expect(cap.status).toBe(401);
    } finally { vi.useRealTimers(); }
  });

  it("data routes stay Bearer-authed and read-only", () => {
    expect(drive(handler, { url: "/api/ui/dashboard" }).status).toBe(401);
    const nonGet = drive(handler, { url: "/ui/", method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(nonGet.status).toBe(405);
  });
});

describe("uiRequestHandler — LAQ-SEC-006 Host gate", () => {
  let handler: ReturnType<typeof uiRequestHandler>;

  beforeEach(() => {
    _resetAuthNonces();
    handler = uiRequestHandler({} as never, TOKEN);
  });

  afterEach(() => vi.useRealTimers());

  it("rejects a rebound Host before auth handling — even with a valid Bearer", () => {
    const cap = drive(handler, {
      url: "/api/ui/dashboard",
      headers: { host: "rebind.evil.example:33000", authorization: `Bearer ${TOKEN}` },
    });
    expect(cap.status).toBe(403);
  });

  it("rejects a rebound Host on the mint endpoint", () => {
    const cap = drive(handler, {
      url: "/ui/mint", method: "POST",
      headers: { host: "rebind.evil.example", authorization: `Bearer ${TOKEN}` },
    });
    expect(cap.status).toBe(403);
  });

  it("allows loopback Hosts through to normal handling", () => {
    for (const host of ["127.0.0.1:33999", "localhost", "[::1]:33000"]) {
      const cap = drive(handler, { url: "/api/ui/dashboard", headers: { host } });
      expect(cap.status).toBe(401); // past the Host gate, stopped by auth
    }
  });
});
