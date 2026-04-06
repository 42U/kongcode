import { describe, it, expect, beforeEach } from "vitest";
import { stageRetrieval, getStagedItems, recordToolOutcome, evaluateRetrieval } from "../src/retrieval-quality.js";
import type { RetrievedItem } from "../src/retrieval-quality.js";

function makeItem(overrides: Partial<RetrievedItem> = {}): RetrievedItem {
  return {
    id: "memory:test1",
    table: "memory",
    text: "SurrealDB uses WebSocket connections for real-time queries",
    score: 0.85,
    importance: 7,
    accessCount: 3,
    finalScore: 0.9,
    fromNeighbor: false,
    ...overrides,
  };
}

describe("stageRetrieval / getStagedItems", () => {
  beforeEach(() => {
    // Clear any pending state
    stageRetrieval("reset", [], undefined);
    evaluateRetrieval("", "", { queryExec: async () => {}, updateUtilityCache: async () => {}, isAvailable: () => false } as any);
  });

  it("stages items and retrieves them", () => {
    const items = [makeItem(), makeItem({ id: "memory:test2" })];
    stageRetrieval("session1", items);
    const staged = getStagedItems();
    expect(staged).toHaveLength(2);
    expect(staged[0].id).toBe("memory:test1");
  });

  it("returns empty array when nothing staged", () => {
    expect(getStagedItems()).toHaveLength(0);
  });

  it("returns a copy, not the original array", () => {
    stageRetrieval("session1", [makeItem()]);
    const a = getStagedItems();
    const b = getStagedItems();
    expect(a).not.toBe(b);
  });
});

describe("recordToolOutcome", () => {
  it("records tool outcomes into pending retrieval", () => {
    stageRetrieval("session1", [makeItem()]);
    recordToolOutcome(true);
    recordToolOutcome(false);
    // Outcomes are consumed by evaluateRetrieval — we just verify no crash
  });

  it("no-ops when nothing is staged", () => {
    // Should not throw
    recordToolOutcome(true);
  });
});

describe("evaluateRetrieval", () => {
  it("writes outcome records to store", async () => {
    const created: any[] = [];
    const mockStore = {
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "SurrealDB WebSocket connection handling" }),
    ]);

    // Response references the retrieved content
    await evaluateRetrieval(
      "turn:123",
      "The SurrealDB WebSocket connection was reset due to a timeout",
      mockStore as any,
    );

    expect(created).toHaveLength(1);
    expect(created[0].session_id).toBe("session1");
    expect(created[0].turn_id).toBe("turn:123");
    expect(created[0].memory_id).toBe("memory:test1");
    expect(created[0].utilization).toBeGreaterThan(0);
  });

  it("high utilization when response references retrieved text", async () => {
    const created: any[] = [];
    const mockStore = {
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "React hooks useState useEffect component lifecycle" }),
    ]);

    await evaluateRetrieval(
      "turn:456",
      "You should use useState and useEffect hooks in your React component lifecycle",
      mockStore as any,
    );

    expect(created[0].utilization).toBeGreaterThan(0.3);
  });

  it("low utilization when response ignores retrieved text", async () => {
    const created: any[] = [];
    const mockStore = {
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "Kubernetes pod scheduling affinity rules" }),
    ]);

    await evaluateRetrieval(
      "turn:789",
      "Here is how to write a Python function that sorts a list",
      mockStore as any,
    );

    expect(created[0].utilization).toBeLessThan(0.2);
  });

  it("clears pending state after evaluation", async () => {
    const mockStore = {
      queryExec: async () => {},
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [makeItem()]);
    await evaluateRetrieval("turn:1", "response", mockStore as any);
    expect(getStagedItems()).toHaveLength(0);
  });

  it("no-ops when nothing staged", async () => {
    const mockStore = {
      queryExec: async () => { throw new Error("should not be called"); },
      updateUtilityCache: async () => {},
    };
    // Should not throw
    await evaluateRetrieval("turn:1", "response", mockStore as any);
  });
});
