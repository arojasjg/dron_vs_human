import RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL } from "../config";
import { GROUP_BUILDING, type Physics } from "../engine/physics";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";

export type Box = [number, number, number, number, number, number];

/** Voxels per chunk edge. Colliders and meshes are rebuilt one chunk at a time. Larger chunks
 *  mean far fewer draw calls (each chunk×material is one draw) at the cost of a slightly heavier
 *  per-chunk rebuild — a good trade for a big building. */
export const CHUNK = 32;

export function chunkCoord(v: number): number {
  return Math.floor(v / CHUNK);
}

/**
 * Greedy box decomposition over a set of packed voxel keys: merges runs of solid
 * voxels into a small set of boxes. Expansion stops at the set boundary, so passing
 * only one chunk's voxels yields chunk-local boxes.
 */
export function greedyBoxesFromKeys(keys: Iterable<number>): Box[] {
  const remaining = new Set<number>(keys);
  const has = (x: number, y: number, z: number) => remaining.has(packKey(x, y, z));
  const boxes: Box[] = [];

  const sorted = [...remaining].sort((a, b) => a - b);
  for (const k of sorted) {
    if (!remaining.has(k)) continue;
    const [x0, y0, z0] = unpackKey(k);

    let x1 = x0;
    while (has(x1 + 1, y0, z0)) x1++;

    let y1 = y0;
    expandY: while (true) {
      for (let x = x0; x <= x1; x++) if (!has(x, y1 + 1, z0)) break expandY;
      y1++;
    }

    let z1 = z0;
    expandZ: while (true) {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) if (!has(x, y, z1 + 1)) break expandZ;
      z1++;
    }

    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) remaining.delete(packKey(x, y, z));

    boxes.push([x0, y0, z0, x1, y1, z1]);
  }
  return boxes;
}

/** Whole-grid greedy meshing (used by tests and the perf harness). */
export function greedyBoxes(grid: VoxelGrid): Box[] {
  return greedyBoxesFromKeys(grid.cells.keys());
}

/**
 * The building's static colliders, partitioned into one FIXED BODY PER CHUNK. This is the key
 * to fast destruction: editing one chunk removes/recreates only that chunk's small body, so
 * Rapier's per-step broadphase work scales with the touched chunk, NOT the whole building. (A
 * single shared body with thousands of colliders makes every collider edit re-cost O(all
 * colliders) inside world.step() — the dominant stall during heavy destruction.)
 */
export class VoxelCollider {
  private readonly bodies = new Map<number, RAPIER.RigidBody>();

  constructor(private readonly physics: Physics) {}

  /** Full rebuild — used at load time and after stamping prefabs. */
  rebuildAll(grid: VoxelGrid): void {
    for (const b of this.bodies.values()) this.physics.world.removeRigidBody(b);
    this.bodies.clear();

    const buckets = new Map<number, number[]>();
    for (const key of grid.cells.keys()) {
      const [x, y, z] = unpackKey(key);
      const ck = packKey(chunkCoord(x), chunkCoord(y), chunkCoord(z));
      let b = buckets.get(ck);
      if (!b) { b = []; buckets.set(ck, b); }
      b.push(key);
    }
    for (const [ck, keys] of buckets) this.build(ck, greedyBoxesFromKeys(keys));
  }

  /** Whether this chunk currently has a physics body (collision LOD streaming). */
  hasChunk(cx: number, cy: number, cz: number): boolean {
    return this.bodies.has(packKey(cx, cy, cz));
  }

  /** Chunk keys that currently have colliders (for streaming out the far ones). */
  builtChunks(): IterableIterator<number> {
    return this.bodies.keys();
  }

  /** Removes one chunk's collider body (it's out of collision range). */
  removeChunk(cx: number, cy: number, cz: number): void {
    const ck = packKey(cx, cy, cz);
    const b = this.bodies.get(ck);
    if (b) { this.physics.world.removeRigidBody(b); this.bodies.delete(ck); }
  }

  /** Removes every collider body (used before re-streaming from scratch). */
  clear(): void {
    for (const b of this.bodies.values()) this.physics.world.removeRigidBody(b);
    this.bodies.clear();
  }

  /** Incremental rebuild of a single chunk after an edit/destruction. */
  rebuildChunk(grid: VoxelGrid, cx: number, cy: number, cz: number): void {
    const ck = packKey(cx, cy, cz);
    const old = this.bodies.get(ck);
    if (old) {
      this.physics.world.removeRigidBody(old); // removes the body and all its colliders at once
      this.bodies.delete(ck);
    }
    const keys: number[] = [];
    const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK; x++)
      for (let y = y0; y < y0 + CHUNK; y++)
        for (let z = z0; z < z0 + CHUNK; z++) {
          if (grid.has(x, y, z)) keys.push(packKey(x, y, z));
        }
    if (keys.length) this.build(ck, greedyBoxesFromKeys(keys));
  }

  private build(ck: number, boxes: Box[]): void {
    if (boxes.length === 0) return;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      const hx = ((x1 - x0 + 1) * VOXEL) / 2;
      const hy = ((y1 - y0 + 1) * VOXEL) / 2;
      const hz = ((z1 - z0 + 1) * VOXEL) / 2;
      const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(x0 * VOXEL + hx, y0 * VOXEL + hy, z0 * VOXEL + hz)
        .setFriction(0.9)
        .setRestitution(0.05)
        .setCollisionGroups(GROUP_BUILDING);
      this.physics.world.createCollider(desc, body);
    }
    this.bodies.set(ck, body);
  }
}
