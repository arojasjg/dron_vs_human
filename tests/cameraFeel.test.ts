import { describe, it, expect } from "vitest";
import { droneBank, hoverSway, speedFov, headBob, DRONE_MAX_BANK, DRONE_FOV_BASE, DRONE_FOV_BOOST } from "../src/engine/cameraFeel";

describe("drone camera feel", () => {
  it("banks INTO a lateral velocity, level at rest, and is clamped", () => {
    expect(droneBank(0, 20)).toBeCloseTo(0);
    expect(droneBank(20, 20)).toBeCloseTo(-DRONE_MAX_BANK);   // full right → max negative roll
    expect(droneBank(-20, 20)).toBeCloseTo(DRONE_MAX_BANK);   // full left → opposite
    expect(Math.abs(droneBank(1000, 20))).toBeLessThanOrEqual(DRONE_MAX_BANK); // clamped
    expect(Math.abs(droneBank(10, 20))).toBeLessThan(Math.abs(droneBank(20, 20))); // monotonic
  });

  it("FOV widens with speed, from base at rest to boost at max", () => {
    expect(speedFov(DRONE_FOV_BASE, DRONE_FOV_BOOST, 0, 20)).toBe(DRONE_FOV_BASE);
    expect(speedFov(DRONE_FOV_BASE, DRONE_FOV_BOOST, 20, 20)).toBe(DRONE_FOV_BOOST);
    expect(speedFov(DRONE_FOV_BASE, DRONE_FOV_BOOST, 10, 20)).toBeGreaterThan(DRONE_FOV_BASE);
    expect(speedFov(DRONE_FOV_BASE, DRONE_FOV_BOOST, 10, 20)).toBeLessThan(DRONE_FOV_BOOST);
  });

  it("hover sway stays small and bounded", () => {
    for (const t of [0, 1, 2.5, 7, 13.3]) {
      const s = hoverSway(t);
      expect(Math.abs(s.dx)).toBeLessThan(0.05);
      expect(Math.abs(s.dy)).toBeLessThan(0.05);
      expect(Math.abs(s.roll)).toBeLessThan(0.05);
    }
  });
});

describe("human head-bob", () => {
  it("is ~zero when standing still and grows with speed", () => {
    const still = headBob(3, 0, 7.5);
    expect(still.dy).toBe(0); expect(still.dx).toBe(0); expect(still.roll).toBe(0);
    // at a stride phase where sin(2·phase) is near its peak, faster = bigger bob
    const slow = Math.abs(headBob(Math.PI / 4, 3, 7.5).dy);
    const fast = Math.abs(headBob(Math.PI / 4, 7.5, 7.5).dy);
    expect(fast).toBeGreaterThan(slow);
  });

  it("stays bounded (never a nauseating lurch)", () => {
    for (const ph of [0, 1, 2, 3.5, 6]) {
      const b = headBob(ph, 7.5, 7.5);
      expect(Math.abs(b.dy)).toBeLessThan(0.1);
      expect(Math.abs(b.dx)).toBeLessThan(0.08);
      expect(Math.abs(b.roll)).toBeLessThan(0.03);
    }
  });
});
