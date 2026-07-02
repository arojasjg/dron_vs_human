import { describe, it, expect } from "vitest";
import { PerfGovernor } from "../src/engine/perfGovernor";

describe("PerfGovernor", () => {
  it("shrinks the budget while FPS stays below target", () => {
    const g = new PerfGovernor(58, 0.2);
    const start = g.budgetScale;
    for (let i = 0; i < 5; i++) g.update(30);
    expect(g.budgetScale).toBeLessThan(start);
  });

  it("never drops below the configured minimum", () => {
    const g = new PerfGovernor(58, 0.2);
    for (let i = 0; i < 100; i++) g.update(5);
    expect(g.budgetScale).toBeGreaterThanOrEqual(0.2);
    expect(g.budgetScale).toBeLessThanOrEqual(0.25);
  });

  it("recovers toward full budget when FPS is healthy", () => {
    const g = new PerfGovernor(58, 0.2);
    for (let i = 0; i < 50; i++) g.update(10); // crush it
    const low = g.budgetScale;
    for (let i = 0; i < 200; i++) g.update(60); // healthy again
    expect(g.budgetScale).toBeGreaterThan(low);
    expect(g.budgetScale).toBeCloseTo(1, 5);
  });

  it("holds steady in a deadband near the target", () => {
    const g = new PerfGovernor(58, 0.2);
    const before = g.budgetScale;
    for (let i = 0; i < 10; i++) g.update(57.5); // within [target-6, target-1]
    expect(g.budgetScale).toBe(before);
  });
});
