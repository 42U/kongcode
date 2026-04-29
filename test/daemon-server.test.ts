import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Helper: pick an ephemeral TCP port to avoid conflicts in parallel tests. */
function ephemeralPort(): number {
  return 30000 + Math.floor(Math.random() * 30000);
}

/** Send a line-delimited JSON-RPC request and resolve when one response
 *  arrives. Closes the socket after. */
async function sendRpc(port: number, payload: object, opts: { keepAlive?: boolean } = {}): Promise<{ socket: any; response: any }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        try {
          const resp = JSON.parse(line);
          if (!opts.keepAlive) sock.end();
          resolve({ socket: sock, response: resp });
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("rpc timeout")), 2000);
  });
}

describe("DaemonServer: basic lifecycle", () => {
  let server: DaemonServer;
  let port: number;

  beforeEach(async () => {
    port = ephemeralPort();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
    });
    server.register("meta.handshake", async () => ({ daemonVersion: "test", protocolVersion: 1 }));
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it("starts with zero clients and zero supersede flag", () => {
    const stats = server.getStats();
    expect(stats.activeClients).toBe(0);
    expect(stats.pendingSupersede).toBe(false);
  });

  it("answers a known method (meta.health)", async () => {
    const { response } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} });
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(response.result.ok).toBe(true);
    expect(typeof response.result.stats.activeClients).toBe("number");
  });

  it("returns -32601 for unknown method", async () => {
    const { response } = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "no.such.method", params: {} });
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
  });

  it("returns -32700 for malformed JSON", async () => {
    const sock = connect({ host: "127.0.0.1", port });
    await new Promise((r) => sock.on("connect", r));
    const responsePromise = new Promise<any>((resolve, reject) => {
      let buffer = "";
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          try { resolve(JSON.parse(buffer.slice(0, nl))); } catch (e) { reject(e); }
        }
      });
      setTimeout(() => reject(new Error("timeout")), 1000);
    });
    sock.write("{ this is not valid json\n");
    const response = await responsePromise;
    expect(response.error.code).toBe(-32700);
    sock.end();
  });
});

describe("DaemonServer: supersede flag", () => {
  let server: DaemonServer;
  let port: number;
  let onSupersedeReady: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    port = ephemeralPort();
    onSupersedeReady = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      onSupersedeReady,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it("markPendingSupersede sets the flag visible in getStats", () => {
    expect(server.getStats().pendingSupersede).toBe(false);
    server.markPendingSupersede();
    expect(server.getStats().pendingSupersede).toBe(true);
    expect(server.isPendingSupersede()).toBe(true);
  });

  it("does not fire onSupersedeReady when no clients have ever connected", () => {
    server.markPendingSupersede();
    expect(onSupersedeReady).not.toHaveBeenCalled();
  });

  it("fires onSupersedeReady on last-client-disconnect when flag is set", async () => {
    // Connect a client; flag the daemon while client is attached.
    const { socket } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1);
    server.markPendingSupersede();
    expect(onSupersedeReady).not.toHaveBeenCalled(); // not yet — client still attached

    // Close the client. After socket-close handler fires, callback should run.
    socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onSupersedeReady when one of multiple clients disconnects", async () => {
    const r1 = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    const r2 = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "meta.health", params: {} }, { keepAlive: true });
    server.markPendingSupersede();
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(2);

    r1.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).not.toHaveBeenCalled();
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1);

    r2.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);
  });

  it("fires onSupersedeReady only once even if checkSupersedeReady triggers twice", async () => {
    const r1 = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    server.markPendingSupersede();
    r1.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);

    // Connect again, disconnect again — flag was already cleared
    const r2 = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "meta.health", params: {} }, { keepAlive: true });
    r2.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1); // still 1
  });
});

describe("DaemonServer: idle reaper", () => {
  let server: DaemonServer;
  let port: number;
  let onIdleReap: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("does not arm timer when idleTimeoutMs is 0", async () => {
    port = ephemeralPort();
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 0,
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();

    await new Promise(r => setTimeout(r, 100));
    expect(onIdleReap).not.toHaveBeenCalled();
  });

  it("arms timer on listen and fires onIdleReap after timeout with no clients", async () => {
    port = ephemeralPort();
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 100, // short for test
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();

    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).toHaveBeenCalledTimes(1);
  });

  it("cancels timer on client connect, re-arms on last disconnect", async () => {
    port = ephemeralPort();
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 150,
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();

    // Connect well before the 150ms timer would fire
    await new Promise(r => setTimeout(r, 50));
    const { socket } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });

    // Wait past the original timer deadline; should NOT have fired (client attached)
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).not.toHaveBeenCalled();

    // Close client, then wait for re-armed timer
    socket.end();
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).toHaveBeenCalledTimes(1);
  });
});

describe("DaemonServer: client identity registry", () => {
  let server: DaemonServer;
  let port: number;

  beforeEach(async () => {
    port = ephemeralPort();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
    });
    server.register("meta.handshake", async (params, ctx) => {
      const p = (params as any) ?? {};
      if (p.clientInfo) ctx.registerIdentity(p.clientInfo);
      return { daemonVersion: "test", protocolVersion: 1 };
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it("registers identity from meta.handshake clientInfo", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.handshake",
      params: { clientInfo: { pid: 12345, version: "0.7.99", sessionId: "test-session" } },
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));

    const stats = server.getStats();
    expect(stats.clients.length).toBeGreaterThan(0);
    const us = stats.clients.find(c => c.pid === 12345);
    expect(us).toBeDefined();
    expect(us?.version).toBe("0.7.99");
    expect(us?.sessionId).toBe("test-session");
    expect(typeof us?.attachedAt).toBe("number");
    socket.end();
  });

  it("anonymous clients (no clientInfo in handshake) still count toward activeClients", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.health",
      params: {},
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));

    const stats = server.getStats();
    expect(stats.activeClients).toBeGreaterThan(0);
    // No identified clients (no handshake with clientInfo was sent)
    expect(stats.clients.length).toBe(0);
    socket.end();
  });

  it("removes identity from registry on socket close", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.handshake",
      params: { clientInfo: { pid: 99999, version: "0.7.99", sessionId: "leaving" } },
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));
    expect(server.getStats().clients.find(c => c.pid === 99999)).toBeDefined();

    socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(server.getStats().clients.find(c => c.pid === 99999)).toBeUndefined();
  });
});
