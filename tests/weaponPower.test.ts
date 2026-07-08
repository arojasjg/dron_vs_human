import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { DebrisSystem } from "../src/destruction/debris";
import { Particles } from "../src/fx/particles";
import { carveSphere } from "../src/destruction/carve";
import { VoxelGrid } from "../src/world/voxelGrid";
import { VOXEL, BLAST_POWER, WEAPON_BLAST_MUL } from "../src/config";
import { roleWeapon } from "../src/net/roles";
import type { MaterialId } from "../src/world/materials";

beforeAll(async () => { await RAPIER.init(); });

function harness() {
  const physics = new Physics();
  const scene = new THREE.Scene();
  const debris = new DebrisSystem(physics, scene);
  const particles = new Particles(scene);
  const grid = new VoxelGrid();
  return { targets: { grid, debris, particles }, grid };
}

// a big flat brick slab in the z=0 plane, large enough that a blast crater sits fully inside it
function slab(grid: VoxelGrid, mat: MaterialId, size: number) {
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) grid.set(x, y, 0, mat);
}

describe("weapon destruction nerf (WEAPON_BLAST_MUL)", () => {
  it("is a real reduction: the nerfed carve power is below every weapon's original", () => {
    expect(WEAPON_BLAST_MUL).toBeGreaterThan(0);
    expect(WEAPON_BLAST_MUL).toBeLessThan(1);                       // it actually reduces
    expect(BLAST_POWER.grenade * WEAPON_BLAST_MUL).toBeLessThan(560); // grenade below its historical 560
    expect(BLAST_POWER.rocket * WEAPON_BLAST_MUL).toBeLessThan(760);  // rocket below 760
    expect(BLAST_POWER.cannon * WEAPON_BLAST_MUL).toBeLessThan(1000); // cannon below 1000
  });

  it("a nerfed grenade blast carves FEWER voxels than the un-nerfed one — but still breaks the wall", () => {
    const SIZE = 44, R = 2.7;                                        // grenade blast radius
    const cx = 22 * VOXEL, cy = 22 * VOXEL, cz = 0.5 * VOXEL;
    const powerFull = BLAST_POWER.grenade * roleWeapon("human").powerMul;   // the original human grenade
    const powerNerfed = powerFull * WEAPON_BLAST_MUL;                       // after the nerf

    const a = harness(); slab(a.grid, "brick", SIZE);
    const full = carveSphere(a.targets, cx, cy, cz, R, powerFull, R * 5, 1);

    const b = harness(); slab(b.grid, "brick", SIZE);
    const nerfed = carveSphere(b.targets, cx, cy, cz, R, powerNerfed, R * 5, 1);

    expect(nerfed.removed).toBeGreaterThan(0);              // the weapon STILL punches through a wall
    expect(nerfed.removed).toBeLessThan(full.removed);      // …but the crater is smaller than before
  });
});
