import { describe, it, expect } from "vitest";
import { bandFor, BAND_LOAD_BEARING_MIN, BAND_SUPPORTING_MIN, BAND_DROP_BELOW } from "../src/engine/graph-context.js";

/** Regression for v0.7.28 reranker-calibrated salience bands.
 *
 * The cross-encoder (bge-reranker-v2-m3) produces sigmoid-calibrated
 * scores in [0,1]. Per GroGU (arxiv 2601.23129), raw retriever scores
 * are weakly predictive of LLM grounding utility — but cross-encoder
 * calibrated probabilities at >0.7 are reliable signal. Three bands
 * give the model a coarse anchor that survives embedder swaps and per-
 * query distribution variance:
 *   - [load-bearing]  >= 0.7  (must ground or explain why not)
 *   - [supporting]    0.3-0.7 (mention if applicable)
 *   - [background]    < 0.3   (skip unless directly relevant)
 *   - dropped         < 0.15  (cross-encoder strongly disagrees with WMR) */
describe("bandFor — reranker score → salience band", () => {
  it("classifies high-confidence scores as load-bearing", () => {
    expect(bandFor(0.95)).toBe("load-bearing");
    expect(bandFor(0.7)).toBe("load-bearing"); // boundary
    expect(bandFor(BAND_LOAD_BEARING_MIN)).toBe("load-bearing");
  });

  it("classifies mid-range scores as supporting", () => {
    expect(bandFor(0.5)).toBe("supporting");
    expect(bandFor(0.3)).toBe("supporting"); // boundary
    expect(bandFor(0.69999)).toBe("supporting");
    expect(bandFor(BAND_SUPPORTING_MIN)).toBe("supporting");
  });

  it("classifies low scores as background", () => {
    expect(bandFor(0.29999)).toBe("background");
    expect(bandFor(0.2)).toBe("background");
    expect(bandFor(BAND_DROP_BELOW)).toBe("background");
    expect(bandFor(0)).toBe("background");
  });

  it("constants are coherent and match documented thresholds", () => {
    expect(BAND_LOAD_BEARING_MIN).toBe(0.7);
    expect(BAND_SUPPORTING_MIN).toBe(0.3);
    expect(BAND_DROP_BELOW).toBe(0.15);
    expect(BAND_LOAD_BEARING_MIN).toBeGreaterThan(BAND_SUPPORTING_MIN);
    expect(BAND_SUPPORTING_MIN).toBeGreaterThan(BAND_DROP_BELOW);
  });
});
