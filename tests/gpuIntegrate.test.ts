import { describe, it, expect } from "vitest";
import { integrate } from "../src/gpu/cpu/integrate";

describe("integrate", () => {
  it("accelerates a particle downward under gravity and moves it", () => {
    const pos = new Float32Array([0, 10, 0]);
    const vel = new Float32Array([0, 0, 0]);
    for (let i = 0; i < 60; i++) integrate(pos, vel, 1, { dt: 1 / 60, gravity: -9.81 });
    expect(vel[1]).toBeLessThan(-9); // ~1s of gravity
    expect(pos[1]).toBeLessThan(10); // it fell
  });

  it("relaxes velocity toward the wind", () => {
    const pos = new Float32Array([0, 100, 0]);
    const vel = new Float32Array([0, 0, 0]);
    for (let i = 0; i < 200; i++) integrate(pos, vel, 1, { dt: 1 / 60, gravity: 0, wind: [5, 0, 0], windCoupling: 1 });
    expect(vel[0]).toBeGreaterThan(0.5);
  });

  it("damping bleeds off speed", () => {
    const pos = new Float32Array([0, 0, 0]);
    const vel = new Float32Array([10, 0, 0]);
    integrate(pos, vel, 1, { dt: 1 / 60, gravity: 0, damping: 0.5 });
    expect(vel[0]).toBeCloseTo(5, 5);
  });
});
