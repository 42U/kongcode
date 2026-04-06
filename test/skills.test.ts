/**
 * Tests for skills.ts — skill extraction, retrieval, formatting,
 * outcome tracking, supersession, and causal graduation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractSkill,
  findRelevantSkills,
  formatSkillContext,
  recordSkillOutcome,
  supersedeOldSkills,
  graduateCausalToSkills,
  type Skill,
} from "../src/skills.js";

// ── Mock helpers ──

function mockStore() {
  return {
    isAvailable: () => true,
    getSessionTurns: vi.fn(async () => [
      { role: "user", text: "fix the bug in auth.ts" },
      { role: "assistant", text: "I'll look at it" },
      { role: "user", text: "it crashes on login" },
      { role: "assistant", text: "Found the issue — null check missing" },
      { role: "user", text: "great, fix it" },
    ]),
    queryFirst: vi.fn(async () => [{ id: "skill:new1" }]),
    queryExec: vi.fn(async () => {}),
    relate: vi.fn(async () => {}),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as any;
}

function mockComplete(response = JSON.stringify({name:"Debug auth",description:"Fix auth bugs",steps:[{tool:"read",description:"Read error logs"}],preconditions:"failing tests",postconditions:"tests pass"})) {
  return vi.fn(async () => ({ text: response }));
}

function makeSampleSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill:s1",
    name: "Debug auth flow",
    description: "Step-by-step auth debugging",
    preconditions: "failing login test",
    steps: [
      { tool: "bash", description: "Run test suite" },
      { tool: "read", description: "Read error output" },
      { tool: "edit", description: "Fix the issue" },
    ],
    postconditions: "all tests pass",
    successCount: 5,
    failureCount: 1,
    avgDurationMs: 30000,
    confidence: 0.9,
    active: true,
    score: 0.85,
    ...overrides,
  };
}

// ── extractSkill ──

describe("extractSkill", () => {
  it("extracts a skill from session turns via LLM", async () => {
    const store = mockStore();
    const complete = mockComplete();
    const result = await extractSkill("session:s1", "task:t1", store, mockEmbeddings(), complete);

    expect(result).toBe("skill:new1");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(store.queryFirst).toHaveBeenCalledWith(
      expect.stringContaining("CREATE skill"),
      expect.objectContaining({
        record: expect.objectContaining({ name: "Debug auth" }),
      }),
    );
  });

  it("returns null when session has fewer than 4 turns", async () => {
    const store = mockStore();
    store.getSessionTurns.mockResolvedValue([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    const result = await extractSkill("session:s1", "task:t1", store, mockEmbeddings(), mockComplete());
    expect(result).toBeNull();
  });

  it("returns null when LLM returns 'null'", async () => {
    const complete = mockComplete("null");
    const result = await extractSkill("session:s1", "task:t1", mockStore(), mockEmbeddings(), complete);
    expect(result).toBeNull();
  });

  it("returns null when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const result = await extractSkill("session:s1", "task:t1", store, mockEmbeddings(), mockComplete());
    expect(result).toBeNull();
  });

  it("creates skill_from_task edge", async () => {
    const store = mockStore();
    await extractSkill("session:s1", "task:t1", store, mockEmbeddings(), mockComplete());
    expect(store.relate).toHaveBeenCalledWith("skill:new1", "skill_from_task", "task:t1");
  });
});

// ── findRelevantSkills ──

describe("findRelevantSkills", () => {
  it("returns skills above 0.4 similarity threshold", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "skill:s1", name: "Deploy", description: "deploy flow", steps: [], score: 0.75, success_count: 3, failure_count: 0 },
      { id: "skill:s2", name: "Low match", description: "irrelevant", steps: [], score: 0.2, success_count: 1, failure_count: 0 },
    ]);

    const queryVec = new Array(1024).fill(0.1);
    const skills = await findRelevantSkills(queryVec, 5, store);

    expect(skills).toHaveLength(1); // only s1 above 0.4
    expect(skills[0].name).toBe("Deploy");
  });

  it("returns empty when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const skills = await findRelevantSkills(new Array(1024).fill(0), 3, store);
    expect(skills).toEqual([]);
  });

  it("returns empty when store is undefined", async () => {
    const skills = await findRelevantSkills(new Array(1024).fill(0), 3, undefined);
    expect(skills).toEqual([]);
  });
});

// ── formatSkillContext ──

describe("formatSkillContext", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillContext([])).toBe("");
  });

  it("formats skill with success rate", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("<skill_context>");
    expect(result).toContain("Debug auth flow");
    expect(result).toContain("5/6 successful");
    expect(result).toContain("[bash] Run test suite");
  });

  it("shows 'new' for skills with no outcomes", () => {
    const result = formatSkillContext([makeSampleSkill({ successCount: 0, failureCount: 0 })]);
    expect(result).toContain("(new)");
  });

  it("includes preconditions and postconditions", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("Pre: failing login test");
    expect(result).toContain("Post: all tests pass");
  });

  it("numbers steps sequentially", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("1. [bash]");
    expect(result).toContain("2. [read]");
    expect(result).toContain("3. [edit]");
  });
});

// ── recordSkillOutcome ──

describe("recordSkillOutcome", () => {
  it("increments success_count on success", async () => {
    const store = mockStore();
    await recordSkillOutcome("skill:s1", true, 5000, store);
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("success_count"),
      { dur: 5000 },
    );
  });

  it("increments failure_count on failure", async () => {
    const store = mockStore();
    await recordSkillOutcome("skill:s1", false, 3000, store);
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("failure_count"),
      { dur: 3000 },
    );
  });

  it("rejects invalid skill IDs", async () => {
    const store = mockStore();
    await recordSkillOutcome("not-a-record-id", true, 1000, store);
    expect(store.queryExec).not.toHaveBeenCalled();
  });

  it("no-ops when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    await recordSkillOutcome("skill:s1", true, 1000, store);
    expect(store.queryExec).not.toHaveBeenCalled();
  });
});

// ── supersedeOldSkills ──

describe("supersedeOldSkills", () => {
  it("deactivates skills with similarity >= 0.82", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "skill:old1", score: 0.90 },
      { id: "skill:old2", score: 0.50 },
    ]);

    await supersedeOldSkills("skill:new1", new Array(1024).fill(0.1), store);

    // Only old1 (0.90 >= 0.82) should be deactivated
    expect(store.queryExec).toHaveBeenCalledTimes(1);
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("active = false"),
      expect.objectContaining({ id: "skill:old1", newId: "skill:new1" }),
    );
  });

  it("no-ops with empty embedding", async () => {
    const store = mockStore();
    await supersedeOldSkills("skill:new1", [], store);
    expect(store.queryFirst).not.toHaveBeenCalled();
  });
});

// ── graduateCausalToSkills ──

describe("graduateCausalToSkills", () => {
  it("graduates causal chains with 3+ successes into skills", async () => {
    const store = mockStore();
    // First call: get grouped causal chains
    store.queryFirst
      .mockResolvedValueOnce([
        { chain_type: "debug", cnt: 5, descriptions: ["fixed null check", "fixed import", "fixed type error"] },
      ])
      // Second call: check if skill already exists for this chain type
      .mockResolvedValueOnce([]) // no existing skill
      // Third call: CREATE skill
      .mockResolvedValueOnce([{ id: "skill:graduated1" }])
      // Fourth+: supersession check
      .mockResolvedValue([]);

    const complete = mockComplete();
    const result = await graduateCausalToSkills(store, mockEmbeddings(), complete);

    expect(result).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("skips chain types that already have a skill", async () => {
    const store = mockStore();
    store.queryFirst
      .mockResolvedValueOnce([
        { chain_type: "debug", cnt: 5, descriptions: ["fixed stuff"] },
      ])
      .mockResolvedValueOnce([{ id: "skill:existing" }]); // already exists

    const complete = mockComplete();
    const result = await graduateCausalToSkills(store, mockEmbeddings(), complete);

    expect(result).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("skips chains with fewer than 3 successes", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValueOnce([
      { chain_type: "debug", cnt: 2, descriptions: ["only two"] },
    ]);

    const complete = mockComplete();
    const result = await graduateCausalToSkills(store, mockEmbeddings(), complete);

    expect(result).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 0 when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const result = await graduateCausalToSkills(store, mockEmbeddings(), mockComplete());
    expect(result).toBe(0);
  });
});
