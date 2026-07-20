import { describe, it, expect } from "vitest";
import { volumeCurve } from "../src/fx/audio";

// The pure perceptual volume curve behind the master-volume slider (v² → finer control at the quiet end).
describe("volumeCurve — perceptual master-volume mapping (pure)", () => {
  it("anchors the endpoints so the invariant holds (0 silent, 1 = current loudness)", () => {
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(1)).toBe(1);
  });

  it("is v² in the middle (half slider → quarter gain before MASTER_BASE)", () => {
    expect(volumeCurve(0.5)).toBe(0.25);
  });

  it("is monotonic increasing across the range", () => {
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const g = volumeCurve(v);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it("clamps out-of-range input (never louder than 1, never below 0)", () => {
    expect(volumeCurve(-0.5)).toBe(0);
    expect(volumeCurve(2)).toBe(1);
  });
});
