import { describe, it, expect } from "vitest";
import { humanFallDamage, droneImpactDamage } from "../src/engine/falldamage";

describe("fall / impact damage", () => {
  it("no damage up to 1 storey, then rising damage with height, monotonically", () => {
    expect(humanFallDamage(0)).toBe(0);
    expect(humanFallDamage(4.75)).toBe(0);              // exactly 1 storey — still safe
    expect(humanFallDamage(2 * 4.75)).toBeGreaterThan(0); // 2 storeys → hurts
    expect(humanFallDamage(4 * 4.75)).toBeGreaterThan(humanFallDamage(2 * 4.75)); // higher = worse
  });

  it("a fall of ~5+ storeys is fatal to a human (>= 150 HP)", () => {
    expect(humanFallDamage(6 * 4.75)).toBeGreaterThanOrEqual(150); // "hasta morir"
  });

  it("the drone is only hurt by a FAST, hard-blocked impact", () => {
    expect(droneImpactDamage(18, 1)).toBe(0);    // cruising (18 m/s) into a wall — harmless
    expect(droneImpactDamage(40, 0.1)).toBe(0);  // fast but NOT blocked (a graze / free air)
    expect(droneImpactDamage(40, 1)).toBeGreaterThan(0);  // boosting (40 m/s) hard into a wall — hurts
    expect(droneImpactDamage(40, 1)).toBeGreaterThan(droneImpactDamage(30, 1)); // faster = worse
  });
});
