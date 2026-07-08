import { VOXEL } from "../config";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";
import { MATERIAL_ORDER, type MaterialId } from "./materials";
import { weatherTint, type RGB } from "./weathering";

// Pure, RAPIER-free voxel "cooking": greedy-box decomposition of a chunk's voxels + (for meshes) the
// per-instance transform matrices and weathering colours. Kept free of THREE and Rapier imports so it can
// run INSIDE a Web Worker (off-thread) without dragging the physics/render WASM into the worker bundle.
// The main thread turns the cooked output into Rapier colliders / InstancedMeshes.

// Painted/reflective/glass materials stay NEUTRAL (no chromatic grime dirties their speculars). Single
// source of truth — voxelMesh imports this both to pick which materials get the mortar shader and here to
// gate the weathering colour. Index form is what the mesh cook uses per instance.
export const NEUTRAL_WEATHER = new Set<MaterialId>(["glass", "metal", "tire", "gastank", "car_red", "car_blue", "car_teal"]);
const NEUTRAL_IDX = new Set<number>([...NEUTRAL_WEATHER].map((m) => MATERIAL_ORDER.indexOf(m)));

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
 * only one chunk's voxels yields chunk-local boxes. Deterministic: the key set is sorted
 * ascending before scanning, so the output depends only on the SET, not iteration order.
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
 * Greedy-cook a chunk's voxel keys into a FLAT Int32Array (6 ints per box: x0,y0,z0,x1,y1,z1) — the
 * transferable form the off-thread cooking worker posts back, and which VoxelCollider.applyBoxes turns
 * into Rapier cuboids. Identical decomposition to greedyBoxesFromKeys (one source of truth).
 */
export function cookColliderBoxes(keys: Iterable<number>): Int32Array {
  const boxes = greedyBoxesFromKeys(keys);
  const out = new Int32Array(boxes.length * 6);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    out[i * 6] = b[0]; out[i * 6 + 1] = b[1]; out[i * 6 + 2] = b[2];
    out[i * 6 + 3] = b[3]; out[i * 6 + 4] = b[4]; out[i * 6 + 5] = b[5];
  }
  return out;
}

/** One material's cooked mesh instances: transferable arrays the main thread copies into an InstancedMesh. */
export interface CookedMeshPart {
  matIdx: number;          // MATERIAL_ORDER index
  matrices: Float32Array;  // 16 floats per box (column-major scale+translate, identity rotation)
  colors: Float32Array;    // 3 floats per box (weathering tint)
}

/**
 * Greedy-cook a chunk's voxels (per material) into InstancedMesh data — the pure, THREE-free half of a
 * mesh rebuild (the ~big part of it). `matIdx[i]` is the MATERIAL_ORDER index of the voxel at `keys[i]`.
 * The axis-aligned transform is written directly (no THREE.Object3D), and weatherTint is a pure hash, so
 * this is byte-identical whether it runs on the main thread or in the worker.
 */
export function cookMeshChunk(keys: ArrayLike<number>, matIdx: ArrayLike<number>): CookedMeshPart[] {
  const byMat = new Map<number, number[]>();
  for (let i = 0; i < keys.length; i++) {
    const m = matIdx[i];
    let arr = byMat.get(m); if (!arr) { arr = []; byMat.set(m, arr); }
    arr.push(keys[i]);
  }
  const parts: CookedMeshPart[] = [];
  const rgb: RGB = { r: 1, g: 1, b: 1 };
  for (const [m, list] of byMat) {
    const boxes = greedyBoxesFromKeys(list);
    const matrices = new Float32Array(boxes.length * 16); // zero-initialised → off-diagonal stays 0
    const colors = new Float32Array(boxes.length * 3);
    const saturate = !NEUTRAL_IDX.has(m);
    for (let i = 0; i < boxes.length; i++) {
      const [x0, y0, z0, x1, y1, z1] = boxes[i];
      const sx = (x1 - x0 + 1) * VOXEL, sy = (y1 - y0 + 1) * VOXEL, sz = (z1 - z0 + 1) * VOXEL;
      const o = i * 16;
      matrices[o] = sx; matrices[o + 5] = sy; matrices[o + 10] = sz;
      matrices[o + 12] = x0 * VOXEL + sx / 2; matrices[o + 13] = y0 * VOXEL + sy / 2; matrices[o + 14] = z0 * VOXEL + sz / 2; matrices[o + 15] = 1;
      weatherTint((x0 + x1) >> 1, (y0 + y1) >> 1, (z0 + z1) >> 1, saturate, rgb);
      colors[i * 3] = rgb.r; colors[i * 3 + 1] = rgb.g; colors[i * 3 + 2] = rgb.b;
    }
    parts.push({ matIdx: m, matrices, colors });
  }
  return parts;
}
