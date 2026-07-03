import { describe, it, expect } from "vitest";
import { weatherMul } from "../src/world/weathering";

describe("voxel weathering", () => {
  it("is deterministic (a hash of position) and bounded", () => {
    expect(weatherMul(3, 7, 11)).toBe(weatherMul(3, 7, 11));      // same voxel → same shade every rebuild
    for (let i = 0; i < 400; i++) {
      const v = weatherMul((i * 7) % 90, (i * 13) % 90, (i * 29) % 90);
      expect(v).toBeGreaterThanOrEqual(0.45);
      expect(v).toBeLessThanOrEqual(1.06);
    }
  });

  it("grimes the lower storeys darker than the upper ones (on average)", () => {
    let low = 0, high = 0, n = 40;
    for (let i = 0; i < n; i++) { low += weatherMul(i, 0, i * 2); high += weatherMul(i, 60, i * 2); }
    expect(low / n).toBeLessThan(high / n); // ground level is grimier
  });

  it("produces varied shades + some dark stains (not a flat surface)", () => {
    const vals = new Set<string>();
    let stains = 0;
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
      const v = weatherMul(x, 10, z); vals.add(v.toFixed(3)); if (v < 0.7) stains++;
    }
    expect(vals.size).toBeGreaterThan(50); // many distinct shades → not flat
    expect(stains).toBeGreaterThan(0);      // some dark stains appear
  });
});
