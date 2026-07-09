import { describe, it, expect } from "vitest";
import { nextResScaleGpu, nextResScaleFps, RES_MIN, RES_MAX, BUDGET_MS } from "../src/engine/dynamicRes";

describe("dynamic resolution — GPU-time controller (the reliable signal)", () => {
  it("shrinks proportionally when over the GPU budget, converging in ~one step", () => {
    // 26ms at scale 1 → sqrt(14/26) ≈ 0.734 in a SINGLE step (vs the old 0.1-per-tick crawl)
    const s = nextResScaleGpu(26, 1.0);
    expect(s).toBeCloseTo(Math.sqrt(BUDGET_MS / 26), 2);
    expect(s).toBeLessThan(0.78);
    // and that new scale lands the frame near budget: 26ms * s² ≈ 14ms
    expect(26 * s * s).toBeCloseTo(BUDGET_MS, 0);
  });

  it("grows back only with real headroom, and holds in the band (no vsync oscillation)", () => {
    expect(nextResScaleGpu(8, 0.7)).toBeCloseTo(0.75); // well under budget → grow
    expect(nextResScaleGpu(11, 0.8)).toBe(0.8);        // in [GROW_MS, BUDGET_MS] → hold
  });

  it("clamps to [RES_MIN, RES_MAX]", () => {
    expect(nextResScaleGpu(60, RES_MIN)).toBe(RES_MIN); // already floored → stays
    expect(nextResScaleGpu(5, RES_MAX)).toBe(RES_MAX);  // already full + headroom → stays
    expect(nextResScaleGpu(999, 1)).toBe(RES_MIN);      // catastrophic → floors, never below
  });
});

describe("dynamic resolution — fps fallback (no GPU timer)", () => {
  it("drops proportionally and converges fast at low fps", () => {
    const s = nextResScaleFps(23, 1.0); // sqrt(23/60) ≈ 0.62 in one tick (was ~2s of -0.1 steps)
    expect(s).toBeCloseTo(Math.sqrt(23 / 60), 2);
    expect(s).toBeLessThan(0.66);
  });

  it("nudges back near the cap and holds in the deadband", () => {
    expect(nextResScaleFps(60, 0.7)).toBeCloseTo(0.73); // near cap → small grow
    expect(nextResScaleFps(55, 0.8)).toBe(0.8);         // deadband → hold
  });

  it("clamps to [RES_MIN, RES_MAX]", () => {
    expect(nextResScaleFps(5, RES_MIN)).toBe(RES_MIN);
    expect(nextResScaleFps(120, RES_MAX)).toBe(RES_MAX);
  });
});
