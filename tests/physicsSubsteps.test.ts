import { describe, it, expect } from "vitest";
import { maxPhysicsSteps, HEAVY_PHYSICS_MS } from "../src/config";

describe("maxPhysicsSteps — adaptive fixed-step catch-up cap", () => {
  it("allows the normal 2-step catch-up when physics is light", () => {
    expect(maxPhysicsSteps(0)).toBe(2);
    expect(maxPhysicsSteps(HEAVY_PHYSICS_MS - 1)).toBe(2);
  });

  it("caps to 1 step when the last physics phase was heavy (avoids doubling the hitch)", () => {
    expect(maxPhysicsSteps(HEAVY_PHYSICS_MS + 1)).toBe(1);
    expect(maxPhysicsSteps(17)).toBe(1); // measured worst: a 29 m tower collapse
  });

  it("is exactly at the boundary: heavy is strictly greater than the threshold", () => {
    expect(maxPhysicsSteps(HEAVY_PHYSICS_MS)).toBe(2); // not yet heavy
  });
});
