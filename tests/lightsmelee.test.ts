import { describe, it, expect } from "vitest";
import { meleeHit } from "../src/net/weapons";
import { flicker } from "../src/engine/interiorLights";

describe("melee reach + cone", () => {
  const RANGE = 2.2, MINDOT = 0.5;
  it("hits an enemy close and in front", () => {
    // attacker at origin facing +z; target 1.5 m ahead
    expect(meleeHit(0, 0, 0, 0, 0, 1, 0, 0, 1.5, RANGE, MINDOT)).toBe(true);
    expect(meleeHit(0, 0, 0, 0, 0, 1, 0, 0, 0.1, RANGE, MINDOT)).toBe(true); // point-blank
  });
  it("misses out of range, behind, or well off to the side", () => {
    expect(meleeHit(0, 0, 0, 0, 0, 1, 0, 0, 3.0, RANGE, MINDOT)).toBe(false);  // too far
    expect(meleeHit(0, 0, 0, 0, 0, 1, 0, 0, -1.5, RANGE, MINDOT)).toBe(false); // behind
    expect(meleeHit(0, 0, 0, 0, 0, 1, 2.0, 0, 0.3, RANGE, MINDOT)).toBe(false); // 90° to the side
  });
});

describe("light flicker", () => {
  it("stays within [0.15, 1] and actually varies over time", () => {
    const vals = [0, 0.3, 0.7, 1.1, 2.4, 5.0].map((t) => flicker(t, 3));
    for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0.15); expect(v).toBeLessThanOrEqual(1); }
    expect(new Set(vals.map((v) => v.toFixed(3))).size).toBeGreaterThan(1); // not constant
  });
});
