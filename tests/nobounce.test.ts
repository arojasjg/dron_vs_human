import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { Projectiles } from "../src/destruction/projectile";
import { VoxelGrid } from "../src/world/voxelGrid";

beforeAll(async () => { await RAPIER.init(); });

function setup() {
  const physics = new Physics();
  physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
  const scene = new THREE.Scene();
  const grid = new VoxelGrid();
  // a solid brick wall two voxels thick around world x≈2 m (voxel x = 8,9), covering the shot line
  for (let y = 0; y <= 6; y++) for (let z = -4; z <= 4; z++) { grid.set(8, y, z, "brick"); grid.set(9, y, z, "brick"); }
  let hits = 0, explodes = 0;
  const proj = new Projectiles(physics, scene, grid, () => { explodes++; }, () => { hits++; });
  const step = (n: number) => { for (let i = 0; i < n; i++) { proj.update(1 / 60); physics.world.step(); } };
  return { proj, step, hits: () => hits, explodes: () => explodes };
}

describe("projectiles never bounce", () => {
  it("a BULLET fired into a wall is consumed at the wall (hit once, then gone — no ricochet)", () => {
    const { proj, step, hits } = setup();
    proj.launchBullet(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 0, 0), 120);
    expect(proj.bulletCount).toBe(1);
    step(40);
    expect(hits()).toBeGreaterThanOrEqual(1); // struck the wall
    expect(proj.bulletCount).toBe(0);         // removed — it did not bounce back or linger
  });

  it("a MISSILE fired into a wall detonates on contact (does not bounce off)", () => {
    const { proj, step, explodes } = setup();
    proj.launchRocket(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 0, 0), 52);
    expect(proj.rocketCount).toBe(1);
    step(60);
    expect(explodes()).toBeGreaterThanOrEqual(1); // blew up at the wall
    expect(proj.rocketCount).toBe(0);             // gone — no ricochet
  });

  it("a bullet with clear air ahead keeps flying (not spuriously consumed)", () => {
    const { proj, step } = setup();
    proj.launchBullet(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(-1, 0, 0), 120); // away from the wall
    step(3);
    expect(proj.bulletCount).toBe(1); // still in flight
  });
});
