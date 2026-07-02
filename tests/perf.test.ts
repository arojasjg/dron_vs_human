import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { VoxelMesher } from "../src/world/voxelMesh";
import { VoxelCollider, greedyBoxes } from "../src/world/voxelCollider";
import { VoxelGrid } from "../src/world/voxelGrid";

beforeAll(async () => {
  await RAPIER.init();
});

function bigWall(grid: VoxelGrid, W: number, H: number, D: number) {
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++)
      for (let z = 0; z < D; z++) grid.set(x, y, z, "brick");
}

function time(label: string, iters: number, fn: () => void): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`PERF ${label}: ${ms.toFixed(2)} ms/op`);
  return ms;
}

describe("perf baseline (CPU rebuild costs)", () => {
  it("measures mesh + collider rebuild on a large structure", () => {
    const grid = new VoxelGrid();
    bigWall(grid, 96, 64, 8); // ~49k voxels, spanning several 32³ chunks
    console.log("PERF voxels:", grid.size, "greedyBoxes:", greedyBoxes(grid).length);

    const physics = new Physics();
    const scene = new THREE.Scene();
    const mesher = new VoxelMesher(scene);
    const collider = new VoxelCollider(physics);

    const meshMs = time("mesher.rebuild full", 20, () => mesher.rebuild(grid));
    const colMs = time("collider.rebuildAll full", 20, () => collider.rebuildAll(grid));

    // worst case: punch many random holes so greedy meshing yields many boxes
    for (let i = 0; i < 16000; i++) {
      const x = (Math.random() * 96) | 0, y = (Math.random() * 64) | 0, z = (Math.random() * 8) | 0;
      grid.remove(x, y, z);
    }
    console.log("PERF holey voxels:", grid.size, "greedyBoxes:", greedyBoxes(grid).length);
    const colHoleyMs = time("collider.rebuildAll holey", 10, () => collider.rebuildAll(grid));

    // the key optimization: an edit only rebuilds the touched chunk, not the world
    collider.rebuildAll(grid);
    const colChunkMs = time("collider.rebuildChunk (single)", 50, () => collider.rebuildChunk(grid, 0, 0, 0));

    console.log(`PERF speedup chunk vs full-holey: ${(colHoleyMs / colChunkMs).toFixed(1)}x`);

    expect(meshMs).toBeLessThan(150);
    expect(colMs).toBeLessThan(200);
    // incremental chunk rebuild must be clearly cheaper than a full-world rebuild
    expect(colChunkMs).toBeLessThan(colHoleyMs / 2);
  });
});
