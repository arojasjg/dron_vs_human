import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Particles } from "../src/fx/particles";

describe("CPU particle idle gate", () => {
  it("stays hidden while idle, shows on a burst, and re-hides once every particle dies", () => {
    const p = new Particles(new THREE.Scene());
    const wind = { x: 0, y: 0, z: 0 };

    p.update(0.016, wind);
    expect(p.points.visible).toBe(false); // nothing spawned → gated off

    p.burst(0, 0, 0, { count: 6, color: 0xffe9b0, speed: 2, size: 3, life: 0.2, buoyancy: 0, windCoupling: 0.1, kind: "spark", strength: 0.5 });
    p.update(0.016, wind);
    expect(p.points.visible).toBe(true);  // alive → pipeline runs

    for (let i = 0; i < 30; i++) p.update(0.05, wind); // ~1.5 s → all past their <0.35s life
    p.update(0.016, wind);                              // one more frame → gate closes
    expect(p.points.visible).toBe(false);
  });
});
