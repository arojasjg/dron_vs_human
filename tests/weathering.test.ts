import { describe, it, expect } from "vitest";
import { weatherMul, weatherTint, type RGB } from "../src/world/weathering";

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

describe("chromatic weathering (weatherTint)", () => {
  const out: RGB = { r: 0, g: 0, b: 0 };

  it("is deterministic and keeps every channel bounded", () => {
    const a = weatherTint(3, 7, 11, true, { r: 0, g: 0, b: 0 });
    const b = weatherTint(3, 7, 11, true, { r: 0, g: 0, b: 0 });
    expect(a).toEqual(b);
    for (let i = 0; i < 400; i++) {
      const t = weatherTint((i * 7) % 90, (i * 13) % 90, (i * 29) % 90, true, out);
      for (const c of [t.r, t.g, t.b]) { expect(c).toBeGreaterThanOrEqual(0.35); expect(c).toBeLessThanOrEqual(1.1); }
    }
  });

  it("stays NEUTRAL (r=g=b) for reflective materials, but tints masonry", () => {
    const neutral = weatherTint(4, 2, 9, false, { r: 0, g: 0, b: 0 });
    expect(neutral.r).toBe(neutral.g);
    expect(neutral.g).toBe(neutral.b); // glass/metal keep clean speculars
    // across masonry voxels, at least some develop a real hue (channels differ)
    let chromatic = 0;
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
      const t = weatherTint(x, 1, z, true, out);
      if (Math.abs(t.r - t.b) > 0.01 || Math.abs(t.g - t.b) > 0.01) chromatic++;
    }
    expect(chromatic).toBeGreaterThan(0); // warm grime / rust streaks give low masonry a hue
  });
});
