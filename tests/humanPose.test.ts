import { describe, it, expect } from "vitest";
import { stanceInfo, legSwing, STANCES } from "../src/net/humanPose";

describe("stances (stand / crouch / prone)", () => {
  it("each lower stance lowers the eye and slows movement", () => {
    expect(stanceInfo(0).eye).toBeGreaterThan(stanceInfo(1).eye);   // crouch below stand
    expect(stanceInfo(1).eye).toBeGreaterThan(stanceInfo(2).eye);   // prone below crouch
    expect(stanceInfo(0).speedMul).toBeGreaterThan(stanceInfo(1).speedMul);
    expect(stanceInfo(1).speedMul).toBeGreaterThan(stanceInfo(2).speedMul);
  });
  it("lower stances drop the remote avatar more, and prone tips the body nearly flat", () => {
    expect(stanceInfo(2).rigLift).toBeGreaterThan(stanceInfo(1).rigLift);
    expect(stanceInfo(1).rigLift).toBeGreaterThan(stanceInfo(0).rigLift);
    expect(stanceInfo(2).bodyLean).toBeGreaterThan(1.0);            // prone ≈ horizontal
    expect(stanceInfo(0).bodyLean).toBe(0);                         // standing upright
  });
  it("falls back to standing for an unknown stance", () => {
    expect(stanceInfo(9 as unknown as 0)).toBe(STANCES[0]);
  });
});

describe("walk-cycle leg swing", () => {
  it("is zero at rest and grows with speed, bounded", () => {
    expect(legSwing(Math.PI / 2, 0, 7.5)).toBe(0);                  // standing → legs still
    const slow = legSwing(Math.PI / 2, 3, 7.5);
    const fast = legSwing(Math.PI / 2, 7.5, 7.5);
    expect(fast).toBeGreaterThan(slow);
    expect(Math.abs(legSwing(Math.PI / 2, 100, 7.5))).toBeLessThanOrEqual(0.7); // clamped
  });
  it("the two legs swing in opposite phase", () => {
    const l = legSwing(1.0, 7.5, 7.5);
    const r = legSwing(1.0 + Math.PI, 7.5, 7.5); // right leg = phase + π
    expect(Math.sign(l)).toBe(-Math.sign(r));
  });
});
