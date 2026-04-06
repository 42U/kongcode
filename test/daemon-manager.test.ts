import { describe, it, expect, vi } from "vitest";
import { startMemoryDaemon } from "../src/daemon-manager.js";

function mockStore() {
  return {
    isAvailable: () => true,
    getSessionTurns: async () => [],
    queryFirst: async () => [],
    queryExec: async () => {},
  } as any;
}

function mockEmbeddings() {
  return {
    isAvailable: () => true,
    embed: async () => new Array(1024).fill(0),
  } as any;
}

function mockComplete() {
  return async () => ({ text: "{}", usage: { input: 0, output: 0 } });
}

describe("startMemoryDaemon", () => {
  it("returns a daemon with expected interface", () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    expect(daemon.sendTurnBatch).toBeTypeOf("function");
    expect(daemon.getStatus).toBeTypeOf("function");
    expect(daemon.shutdown).toBeTypeOf("function");
    expect(daemon.getExtractedTurnCount).toBeTypeOf("function");
  });

  it("starts with 0 extracted turns", () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    expect(daemon.getExtractedTurnCount()).toBe(0);
  });

  it("reports status correctly", async () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    const status = await daemon.getStatus();
    expect(status.type).toBe("status");
    expect(status.extractedTurns).toBe(0);
    expect(status.pendingBatches).toBe(0);
    expect(status.errors).toBe(0);
  });

  it("accepts turn batches without throwing", () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    // Should not throw
    daemon.sendTurnBatch(
      [{ role: "user", text: "hello", turnId: "t1" }, { role: "assistant", text: "hi", turnId: "t2" }],
      [],
      [],
    );
  });

  it("ignores batches after shutdown", async () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    await daemon.shutdown(100);
    // Should silently ignore
    daemon.sendTurnBatch(
      [{ role: "user", text: "hello", turnId: "t1" }],
      [],
      [],
    );
    const status = await daemon.getStatus();
    expect(status.pendingBatches).toBe(0);
  });

  it("shutdown resolves even with no pending work", async () => {
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", mockComplete());
    await daemon.shutdown(100);
  });

  it("times out extraction when it exceeds timeout", async () => {
    // Complete function that never resolves
    const neverComplete = () => new Promise<any>(() => {});
    const daemon = startMemoryDaemon(mockStore(), mockEmbeddings(), "session1", neverComplete, 200);

    daemon.sendTurnBatch(
      [
        { role: "user", text: "hello world test", turnId: "t1" },
        { role: "assistant", text: "response here", turnId: "t2" },
      ],
      [],
      [],
    );

    // Wait for timeout to trigger
    await new Promise(r => setTimeout(r, 500));

    const status = await daemon.getStatus();
    expect(status.errors).toBe(1);
  });
});
