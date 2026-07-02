import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { resolveDebrisImpacts } from "../src/destruction/impact";
import { Physics } from "../src/engine/physics";
import { DebrisSystem } from "../src/destruction/debris";
import { DEBRIS_IMPACT_KE } from "../src/config";

const CFG = { keThreshold: 180, tankR: 1.1, droneR: 1.2, dmgPerKe: 0.03, maxDronePerFrame: 25 };

describe("resolveDebrisImpacts (pure)", () => {
  const tank = (live = true) => [{ x: 0, y: 0, z: 0, live }];

  it("a fast chunk touching a live tank detonates it; a slow one does not", () => {
    const fast = resolveDebrisImpacts([{ x: 0.5, y: 0, z: 0, ke: 1000 }], tank(), null, CFG);
    expect(fast.tanks).toEqual([0]);
    const slow = resolveDebrisImpacts([{ x: 0.5, y: 0, z: 0, ke: 50 }], tank(), null, CFG);
    expect(slow.tanks).toEqual([]);
  });

  it("does not touch a tank that is already spent, or one out of reach", () => {
    expect(resolveDebrisImpacts([{ x: 0.5, y: 0, z: 0, ke: 1000 }], tank(false), null, CFG).tanks).toEqual([]);
    expect(resolveDebrisImpacts([{ x: 5, y: 0, z: 0, ke: 1000 }], tank(), null, CFG).tanks).toEqual([]);
  });

  it("hurts the drone when a fast chunk is close, capped per frame; nothing when far or slow", () => {
    const drone = { x: 0, y: 0, z: 0 };
    const hit = resolveDebrisImpacts([{ x: 0.4, y: 0, z: 0, ke: 1000 }], [], drone, CFG);
    expect(hit.droneDamage).toBeGreaterThan(0);
    expect(hit.droneDamage).toBeLessThanOrEqual(CFG.maxDronePerFrame); // clamped
    expect(resolveDebrisImpacts([{ x: 3, y: 0, z: 0, ke: 1000 }], [], drone, CFG).droneDamage).toBe(0);
    expect(resolveDebrisImpacts([{ x: 0.4, y: 0, z: 0, ke: 50 }], [], drone, CFG).droneDamage).toBe(0);
  });

  it("detonates each tank at most once even under a barrage", () => {
    const barrage = [
      { x: 0.2, y: 0, z: 0, ke: 1000 }, { x: 0.3, y: 0, z: 0, ke: 1000 }, { x: 0.1, y: 0, z: 0, ke: 1000 },
    ];
    expect(resolveDebrisImpacts(barrage, tank(), null, CFG).tanks).toEqual([0]);
  });
});

describe("DebrisSystem.impacts (real kinetic energy)", () => {
  beforeAll(async () => { await RAPIER.init(); });

  const spawnAndMeasure = (vx: number, vy: number, vz: number) => {
    const physics = new Physics();
    const debris = new DebrisSystem(physics, new THREE.Scene());
    debris.spawn(0, 5, 0, "concrete", vx, vy, vz);
    return debris.impacts()[0].ke;
  };

  it("a fast chunk clears the impact threshold; a slow one stays below it", () => {
    expect(spawnAndMeasure(12, 0, 0)).toBeGreaterThan(DEBRIS_IMPACT_KE);
    expect(spawnAndMeasure(0.5, 0, 0)).toBeLessThan(DEBRIS_IMPACT_KE);
  });
});
