import RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL } from "../config";
import { GROUP_BUILDING, type Physics } from "../engine/physics";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";
import { greedyBoxesFromKeys, greedyBoxes, cookColliderBoxes, chunkCoord, CHUNK, type Box } from "./cook";

// The greedy cook now lives in the RAPIER-free ./cook module (so a Web Worker can run it). Re-exported
// here for back-compat — historically callers import these from voxelCollider.
export { greedyBoxesFromKeys, greedyBoxes, chunkCoord, CHUNK };
export type { Box };

/**
 * The building's static colliders, partitioned into one FIXED BODY PER CHUNK. This is the key
 * to fast destruction: editing one chunk removes/recreates only that chunk's small body, so
 * Rapier's per-step broadphase work scales with the touched chunk, NOT the whole building. (A
 * single shared body with thousands of colliders makes every collider edit re-cost O(all
 * colliders) inside world.step() — the dominant stall during heavy destruction.)
 *
 * The greedy-box COOK (the ~80% of a rebuild's CPU) is a pure function that can run off-thread; this
 * class only turns cooked boxes into Rapier bodies via applyBoxes (the ~20% that must stay main-thread).
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
    for (const [ck, keys] of buckets) this.applyBoxes(ck, cookColliderBoxes(keys));
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

  /** Incremental rebuild of a single chunk after an edit/destruction (synchronous cook + apply). */
  rebuildChunk(grid: VoxelGrid, cx: number, cy: number, cz: number): void {
    const keys = grid.chunkVoxelKeys(cx, cy, cz); // O(voxels present), not 32768 has()-probes
    this.applyBoxes(packKey(cx, cy, cz), cookColliderBoxes(keys));
  }

  /**
   * Replaces one chunk's collider body from ALREADY-COOKED flat boxes (6 ints/box: x0,y0,z0,x1,y1,z1).
   * The cook can come from the synchronous path OR the off-thread worker — both feed the same Rapier
   * creation here. Removing the old body + creating the new is atomic (no collision gap).
   */
  applyBoxes(ck: number, boxes: Int32Array): void {
    const old = this.bodies.get(ck);
    if (old) { this.physics.world.removeRigidBody(old); this.bodies.delete(ck); } // body + all its colliders
    if (boxes.length === 0) return;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (let i = 0; i < boxes.length; i += 6) {
      const x0 = boxes[i], y0 = boxes[i + 1], z0 = boxes[i + 2], x1 = boxes[i + 3], y1 = boxes[i + 4], z1 = boxes[i + 5];
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
