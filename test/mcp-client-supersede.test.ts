import { describe, it, expect } from "vitest";
import { decideOrphanAction, __testing } from "../src/mcp-client/index.js";

const { compareSemver } = __testing;

describe("compareSemver", () => {
  it("returns 0 for identical versions", () => {
    expect(compareSemver("0.7.15", "0.7.15")).toBe(0);
  });

  it("returns positive when first is newer", () => {
    expect(compareSemver("0.7.16", "0.7.15")).toBeGreaterThan(0);
    expect(compareSemver("0.8.0", "0.7.15")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("returns negative when first is older", () => {
    expect(compareSemver("0.7.14", "0.7.15")).toBeLessThan(0);
    expect(compareSemver("0.6.0", "0.7.0")).toBeLessThan(0);
  });

  it("handles missing patch component (treated as 0)", () => {
    expect(compareSemver("0.7", "0.7.0")).toBe(0);
    expect(compareSemver("0.7.1", "0.7")).toBeGreaterThan(0);
  });

  it("handles 2-digit minor and patch correctly (lexicographic trap)", () => {
    // The trap: lexicographic compare would say "0.7.9" > "0.7.10" because '9' > '1'.
    // Numeric compare correctly says "0.7.10" > "0.7.9".
    expect(compareSemver("0.7.10", "0.7.9")).toBeGreaterThan(0);
    expect(compareSemver("0.7.9", "0.7.10")).toBeLessThan(0);
  });

  it("handles different-length versions", () => {
    expect(compareSemver("0.7.15.1", "0.7.15")).toBeGreaterThan(0);
    expect(compareSemver("0.7", "0.7.15")).toBeLessThan(0);
  });

  it("treats non-numeric components as 0", () => {
    expect(compareSemver("0.7.abc", "0.7.0")).toBe(0); // "abc" → 0
    // Number("5-rc") returns NaN; `Number(s) || 0` falls back to 0.
    // So "0.7.5-rc.1" parses as [0, 7, 0, 1] vs "0.7.5" as [0, 7, 5].
    // [0,7,0,1] < [0,7,5] at index 2 → negative result.
    expect(compareSemver("0.7.5-rc.1", "0.7.5")).toBeLessThan(0);
  });
});

describe("decideOrphanAction", () => {
  it("returns 'abstain' when activeClients is undefined", () => {
    expect(decideOrphanAction(undefined)).toBe("abstain");
  });

  it("returns 'recycle' when activeClients is 1 (only us)", () => {
    expect(decideOrphanAction(1)).toBe("recycle");
  });

  it("returns 'recycle' when activeClients is 0 (edge — daemon counts pre-handshake?)", () => {
    expect(decideOrphanAction(0)).toBe("recycle");
  });

  it("returns 'wait' when activeClients > 1 (siblings attached)", () => {
    expect(decideOrphanAction(2)).toBe("wait");
    expect(decideOrphanAction(5)).toBe("wait");
    expect(decideOrphanAction(100)).toBe("wait");
  });
});
