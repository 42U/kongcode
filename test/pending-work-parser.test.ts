import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Regression for v0.7.32 graduation-pipeline parser hardening.
 *
 * The 0.7.31 root-cause investigation showed `parseCausalGraduationResult`
 * silently returned `[]` for any subagent submission that didn't match the
 * canonical top-level array shape — wrapped objects, single-skill emissions,
 * and string-array `steps` all dropped without a log line. This release
 * makes the parser tolerant of common shapes and adds drop-reason telemetry.
 *
 * The parser helpers are not exported (file-internal). To pin behavior we
 * import the module under test and exercise the public commit_work_results
 * code path through `commitWorkResults` against a mocked store, asserting on
 * the canonical `createSkill` call sites. But that's heavyweight; instead we
 * test the parsers directly via a re-export of the test harness — added to
 * pending-work.ts as a `__test__` export. */

// We expose the parsers via dynamic import, picking them off the module
// namespace. The functions are file-internal but coverage is essential, so
// pending-work.ts re-exports them under `__test__` for the test harness only.
import * as pendingWork from "../src/tools/pending-work.js";

const parsers = (pendingWork as any).__test__ as {
  parseSkillResult: (r: unknown) => any | null;
  parseCausalGraduationResult: (r: unknown) => any[];
};

describe("graduation-pipeline parser tolerance", () => {
  // Silence the warn telemetry to keep test output clean. Tests still
  // validate that drops happen correctly via the return value.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe("parseCausalGraduationResult — top-level array (regression)", () => {
    it("accepts canonical top-level array shape", () => {
      const out = parsers.parseCausalGraduationResult([
        { name: "skill_a", description: "desc", steps: [{ tool: "bash", description: "run it" }] },
        { name: "skill_b", description: "desc", steps: [{ tool: "edit", description: "edit it" }] },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].name).toBe("skill_a");
      expect(out[1].name).toBe("skill_b");
    });

    it("accepts JSON-string of top-level array", () => {
      const json = JSON.stringify([{ name: "x", description: "d", steps: [{ tool: "t", description: "s" }] }]);
      const out = parsers.parseCausalGraduationResult(json);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("x");
    });
  });

  describe("parseCausalGraduationResult — wrapped object (NEW)", () => {
    it("unwraps {skills: [...]} shape", () => {
      const out = parsers.parseCausalGraduationResult({
        skills: [{ name: "s1", description: "d", steps: [{ tool: "t", description: "x" }] }],
      });
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("s1");
    });

    it("unwraps {result: [...]} shape", () => {
      const out = parsers.parseCausalGraduationResult({
        result: [{ name: "s2", description: "d", steps: [{ tool: "t", description: "x" }] }],
      });
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("s2");
    });

    it("unwraps {extracted: [...]}, {items: [...]}, {data: [...]} shapes", () => {
      for (const key of ["extracted", "items", "data"]) {
        const out = parsers.parseCausalGraduationResult({
          [key]: [{ name: `from_${key}`, description: "d", steps: [{ tool: "t", description: "x" }] }],
        });
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe(`from_${key}`);
      }
    });
  });

  describe("parseCausalGraduationResult — single-skill object (NEW)", () => {
    it("treats {name, steps} object as a single-element array", () => {
      const out = parsers.parseCausalGraduationResult({
        name: "lonely_skill",
        description: "d",
        steps: [{ tool: "t", description: "x" }],
      });
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("lonely_skill");
    });
  });

  describe("parseSkillResult — steps coercion (NEW)", () => {
    it("coerces string-array steps to {tool, description} objects", () => {
      const out = parsers.parseSkillResult({
        name: "stringy",
        description: "d",
        steps: ["step one as plain string", "step two as plain string"],
      });
      expect(out).not.toBeNull();
      expect(out.steps).toEqual([
        { tool: "unknown", description: "step one as plain string" },
        { tool: "unknown", description: "step two as plain string" },
      ]);
    });

    it("accepts name aliases (title, skill_name, id)", () => {
      expect(parsers.parseSkillResult({
        title: "from_title",
        steps: [{ tool: "t", description: "x" }],
      })?.name).toBe("from_title");
      expect(parsers.parseSkillResult({
        skill_name: "from_skill_name",
        steps: [{ tool: "t", description: "x" }],
      })?.name).toBe("from_skill_name");
    });

    it("falls back to alias fields on step objects", () => {
      const out = parsers.parseSkillResult({
        name: "alias_steps",
        steps: [{ name: "bash", text: "run it" }],
      });
      expect(out).not.toBeNull();
      expect(out.steps[0]).toEqual({ tool: "bash", description: "run it" });
    });
  });

  describe("truly invalid inputs still drop", () => {
    it("drops object with no name AND no name aliases", () => {
      const out = parsers.parseSkillResult({
        description: "no name anywhere",
        steps: [{ tool: "t", description: "x" }],
      });
      expect(out).toBeNull();
    });

    it("drops object with empty steps array", () => {
      const out = parsers.parseSkillResult({
        name: "empty_steps",
        steps: [],
      });
      expect(out).toBeNull();
    });

    it("returns [] on garbage non-JSON string", () => {
      const out = parsers.parseCausalGraduationResult("not json at all");
      expect(out).toEqual([]);
    });

    it("returns [] on a number primitive", () => {
      const out = parsers.parseCausalGraduationResult(42);
      expect(out).toEqual([]);
    });
  });
});
