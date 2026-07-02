import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { ChunkDebris } from "../src/destruction/chunkDebris";
import type { Voxel } from "../src/world/structuralIntegrity";

beforeAll(async () => {
  await RAPIER.init();
});

function countDynamic(physics: Physics): number {
  let n = 0;
  physics.world.forEachRigidBody((b) => { if (b.isDynamic()) n++; });
  return n;
}

describe("ChunkDebris (rigid multi-voxel slabs)", () => {
  it("spawns ONE rigid body for a connected slab of many voxels", () => {
    const physics = new Physics();
    const scene = new THREE.Scene();
    const chunks = new ChunkDebris(physics, scene);

    const slab: Voxel[] = [];
    for (let x = 0; x < 5; x++)
      for (let y = 10; y < 15; y++)
        for (let z = 0; z < 2; z++) slab.push([x, y, z]);
    expect(slab.length).toBe(50);

    const ok = chunks.spawn(slab, () => "concrete", 0, 0, 0);
    expect(ok).toBe(true);
    expect(chunks.count).toBe(1);
    // 50 voxels -> a single dynamic body, not 50
    expect(countDynamic(physics)).toBe(1);
  });

  it("the slab is a real rigid body that falls under gravity", () => {
    const physics = new Physics();
    const scene = new THREE.Scene();
    const chunks = new ChunkDebris(physics, scene);

    const slab: Voxel[] = [];
    for (let x = 0; x < 4; x++) for (let y = 20; y < 22; y++) slab.push([x, y, 0]);
    chunks.spawn(slab, () => "wood", 0, 0, 0);

    let y0 = 0;
    physics.world.forEachRigidBody((b) => { if (b.isDynamic()) y0 = b.translation().y; });
    let t = 0;
    for (let i = 0; i < 60; i++) { physics.step(t); t += 1 / 60; chunks.update(1 / 60); }
    let y1 = 0;
    physics.world.forEachRigidBody((b) => { if (b.isDynamic()) y1 = b.translation().y; });

    expect(y1).toBeLessThan(y0 - 0.5); // it fell
  });
});
