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
    const g = new PerfGovernor(58, 16, 0.2);
    const before = g.budgetScale;
    for (let i = 0; i < 10; i++) g.update(57.5); // no gpuMs → fps-only; already at 1, so grow clamps to hold
    expect(g.budgetScale).toBe(before);
  });

  it("throttles on GPU-ms even when the (choppy) averaged fps looks healthy", () => {
    // the destruction case: fps averages to a fine 60 but the GPU is pinned at 50 ms by debris geometry
    const g = new PerfGovernor(60, 16, 0.2);
    for (let i = 0; i < 5; i++) g.update(60, 50);
    expect(g.budgetScale).toBeLessThan(1);
  });

  it("recovers only when the GPU is comfortably under budget", () => {
    const g = new PerfGovernor(60, 16, 0.2);
    for (let i = 0; i < 30; i++) g.update(40, 50); // GPU-bound → floor
    const low = g.budgetScale;
    for (let i = 0; i < 5; i++) g.update(60, 15); // GPU right at budget edge → must NOT bounce back up
    expect(g.budgetScale).toBe(low);
    for (let i = 0; i < 100; i++) g.update(60, 8); // real GPU headroom → restore
    expect(g.budgetScale).toBeGreaterThan(low);
  });
});
