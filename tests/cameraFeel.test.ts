import { describe, it, expect } from "vitest";
import { droneBank, hoverSway, speedFov, headBob, addTrauma, decayTrauma, shakeOffset, SHAKE_POS, SHAKE_ROLL, DRONE_MAX_BANK, DRONE_FOV_BASE, DRONE_FOV_BOOST } from "../src/engine/cameraFeel";

describe("screen-shake trauma model (aim-safe)", () => {
  it("accumulates trauma clamped to [0,1] and decays to 0", () => {
    expect(addTrauma(0, 0.3)).toBeCloseTo(0.3);
    expect(addTrauma(0.9, 0.5)).toBe(1);            // clamps up
    expect(addTrauma(0.1, -1)).toBe(0);             // clamps down
    let t = 1; for (let i = 0; i < 100; i++) t = decayTrauma(t, 0.02); // 2s
    expect(t).toBe(0);                               // always settles
  });

  it("scales shake with trauma² and is zero at rest", () => {
    expect(shakeOffset(0, 5)).toEqual({ dx: 0, dy: 0, dz: 0, roll: 0 });
    // find the peak |dx| over a time sweep at two trauma levels; ratio ≈ (t1/t2)²
    const peak = (tr: number) => { let m = 0; for (let t = 0; t < 6; t += 0.001) m = Math.max(m, Math.abs(shakeOffset(tr, t).dx)); return m; };
    expect(peak(0.5) / peak(1.0)).toBeCloseTo(0.25, 1); // 0.5² / 1² = 0.25
  });

  it("never exceeds the configured amplitude bounds (aim-safe: only pos + roll returned)", () => {
    for (let t = 0; t < 3; t += 0.01) {
      const o = shakeOffset(1, t);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(SHAKE_POS + 1e-9);
      expect(Math.abs(o.roll)).toBeLessThanOrEqual(SHAKE_ROLL + 1e-9);
      expect(Object.keys(o).sort()).toEqual(["dx", "dy", "dz", "roll"]); // no yaw/pitch → aim never moves
    }
  });
});

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
