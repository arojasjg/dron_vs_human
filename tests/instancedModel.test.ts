import { describe, it, expect } from "vitest";
import { fitTransform } from "../src/engine/instancedModel";

describe("fitTransform — fit a model bbox to a target height, base on the ground (pure)", () => {
  it("scales so the fitted height equals targetH", () => {
    const t = fitTransform([-1, 0, -1], [1, 4, 1], 2); // 4 tall → scale 0.5
    expect(t.scale).toBeCloseTo(0.5);
  });

  it("puts the base at y=0 after scaling (dy cancels the scaled min.y)", () => {
    const t = fitTransform([-1, 2, -1], [1, 6, 1], 2); // min.y=2, h=4 → scale .5, dy = -2*.5 = -1
    expect(t.scale).toBeCloseTo(0.5);
    expect(t.dy).toBeCloseTo(-1);          // scaled min.y (2*.5=1) + dy(-1) = 0 → base on ground
    expect(2 * t.scale + t.dy).toBeCloseTo(0);
  });

  it("centres the model in XZ (scaled centre + offset = 0)", () => {
    const t = fitTransform([0, 0, 4], [4, 2, 8], 2); // cx=2, cz=6; h=2 → scale 1
    expect(t.scale).toBeCloseTo(1);
    expect(2 * t.scale + t.dx).toBeCloseTo(0); // scaled centre X lands at origin
    expect(6 * t.scale + t.dz).toBeCloseTo(0);
  });

  it("targetH<=0 keeps native size (identity scale, still grounds + centres)", () => {
    const t = fitTransform([-1, 1, -1], [1, 3, 1], 0);
    expect(t.scale).toBe(1);
    expect(t.dy).toBeCloseTo(-1); // base to ground even at native scale
  });

  it("guards a degenerate zero-height bbox (no divide-by-zero)", () => {
    const t = fitTransform([0, 0, 0], [0, 0, 0], 2);
    expect(t.scale).toBe(1);
    expect(Number.isFinite(t.dx)).toBe(true);
    expect(Number.isFinite(t.dy)).toBe(true);
  });
});
