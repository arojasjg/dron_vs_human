import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { DebrisSystem } from "../src/destruction/debris";
import { Particles } from "../src/fx/particles";
import { carveSphere } from "../src/destruction/carve";
import { explode } from "../src/destruction/explosion";
import { VoxelGrid } from "../src/world/voxelGrid";
import { VOXEL } from "../src/config";
import type { MaterialId } from "../src/world/materials";

beforeAll(async () => {
  await RAPIER.init();
});

function harness() {
  const physics = new Physics();
  const scene = new THREE.Scene();
  const debris = new DebrisSystem(physics, scene);
  const particles = new Particles(scene);
  const grid = new VoxelGrid();
  return { physics, debris, particles, grid, targets: { grid, debris, particles } };
}

function fillWall(grid: VoxelGrid, mat: MaterialId, size = 8) {
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) grid.set(x, y, 0, mat);
}

describe("carveSphere", () => {
  it("opens a hole in a brick wall exactly where it is hit and produces debris", () => {
    const h = harness();
    fillWall(h.grid, "brick");
    const before = h.grid.size;
    const cx = 4 * VOXEL, cy = 4 * VOXEL, cz = 0.5 * VOXEL;
    const res = carveSphere(h.targets, cx, cy, cz, 0.5, 200, 9);
    expect(res.removed).toBeGreaterThan(0);
    expect(h.grid.size).toBe(before - res.removed);
    // the center voxel of the impact must be gone
    expect(h.grid.has(4, 4, 0)).toBe(false);
    // debris bodies were spawned for the removed voxels
    expect(h.debris.count).toBeGreaterThan(0);
  });

  it("metal resists a weak impact (no hole), glass shatters from the same energy", () => {
    const metal = harness();
    fillWall(metal.grid, "metal");
    const m = carveSphere(metal.targets, 4 * VOXEL, 4 * VOXEL, 0.5 * VOXEL, 0.5, 40, 6);
    expect(m.removed).toBe(0);

    const glass = harness();
    fillWall(glass.grid, "glass");
    const g = carveSphere(glass.targets, 4 * VOXEL, 4 * VOXEL, 0.5 * VOXEL, 0.5, 40, 6);
    expect(g.removed).toBeGreaterThan(0);
  });
});

describe("explode", () => {
  it("carves a crater and pushes a nearby dynamic body outward", () => {
    const h = harness();
    fillWall(h.grid, "concrete", 12);

    // a free dynamic body sitting just in front of the blast
    const body = h.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(6 * VOXEL, 6 * VOXEL, 1.5),
    );
    h.physics.world.createCollider(RAPIER.ColliderDesc.ball(0.2).setDensity(300), body);
    const v0 = body.linvel();
    expect(Math.hypot(v0.x, v0.y, v0.z)).toBeCloseTo(0, 5);

    const { removed } = explode(h.physics, h.targets, 6 * VOXEL, 6 * VOXEL, 0, 1.2, 300);
    expect(removed).toBeGreaterThan(0);

    const v1 = body.linvel();
    expect(Math.hypot(v1.x, v1.y, v1.z)).toBeGreaterThan(0.5);
    expect(v1.z).toBeGreaterThan(0); // pushed away from the blast (+z)
  });
});

describe("irregular crater", () => {
  function solidCube(grid: VoxelGrid, mat: MaterialId, n: number) {
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++)
        for (let z = 0; z < n; z++) grid.set(x, y, z, mat);
  }
  const C = 15.5 * VOXEL, R = 1.6;
  const rayExtent = (grid: VoxelGrid, sx: number, sy: number, sz: number) => {
    let k = 1;
    while (k < 20 && !grid.has(15 + sx * k, 15 + sy * k, 15 + sz * k)) k++;
    return k - 1; // consecutive voxels removed from the centre along this ray
  };

  it("carves a lumpy, non-spherical crater", () => {
    const h = harness();
    solidCube(h.grid, "glass", 31);
    carveSphere(h.targets, C, C, C, R, 5000, 8);
    const ext = [
      rayExtent(h.grid, 1, 0, 0), rayExtent(h.grid, -1, 0, 0),
      rayExtent(h.grid, 0, 1, 0), rayExtent(h.grid, 0, -1, 0),
      rayExtent(h.grid, 0, 0, 1), rayExtent(h.grid, 0, 0, -1),
    ];
    expect(Math.min(...ext)).toBeGreaterThan(0);        // it carves in every direction
    expect(Math.max(...ext) - Math.min(...ext)).toBeGreaterThanOrEqual(2); // clearly not a sphere
  });

  it("carves identically every time (deterministic → multiplayer-safe)", () => {
    const a = harness(); solidCube(a.grid, "glass", 31);
    const b = harness(); solidCube(b.grid, "glass", 31);
    carveSphere(a.targets, C, C, C, R, 5000, 8);
    carveSphere(b.targets, C, C, C, R, 5000, 8);
    expect(b.grid.size).toBe(a.grid.size); // same voxels removed, no Math.random in the decision
    for (const [sx, sy, sz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]] as const)
      expect(rayExtent(b.grid, sx, sy, sz)).toBe(rayExtent(a.grid, sx, sy, sz));
  });
});

describe("aerodynamics (wind/air)", () => {
  it("wind pushes a light free body downwind over time", () => {
    const physics = new Physics();
    physics.wind.x = 8; physics.wind.y = 0; physics.wind.z = 0;
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 50, 0).setLinearDamping(0),
    );
    body.userData = { area: 0.04, cd: 1.1 };
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.1, 0.1).setDensity(200), body);

    let t = 0;
    for (let i = 0; i < 200; i++) { physics.step(t); t += 1 / 60; }
    expect(body.linvel().x).toBeGreaterThan(0.1);
  });
});
