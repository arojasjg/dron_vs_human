import { VOXEL } from "../config";
import { unpackKey, KEY_SPAN, type VoxelGrid } from "./voxelGrid";
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

// RENDER chunk — deliberately LARGER than the collider chunk. Rendering cost is dominated by the sheer
// COUNT of InstancedMeshes Three.js must traverse/cull/submit every frame (one per chunk×material), which
// scaled badly when the town tripled (measured ~2100 draw calls / ~11 ms CPU from an open view). A bigger
// mesh chunk means far fewer, larger meshes → far fewer draw calls. Kept SEPARATE from CHUNK so the
// collider streaming/LOD (tuned to avoid a broadphase hitch) is untouched: MESH_CHUNK must be a multiple
// of CHUNK so a collider chunk maps cleanly onto its parent mesh chunk (meshCoord = colCoord / RATIO).
export const MESH_CHUNK = 64;
export const MESH_CHUNK_RATIO = MESH_CHUNK / CHUNK; // collider chunks per mesh chunk, per axis

export function meshChunkCoord(v: number): number {
  return Math.floor(v / MESH_CHUNK);
}

// Dense membership scratch for greedyBoxesFromKeys: a reusable byte per cell of the keys' bounding
// box, so a membership probe is one indexed read and a delete one indexed write (vs a packKey hash
// per probe with a Set). Grow-only and NEVER cleared wholesale: every marked cell belongs to exactly
// one emitted box and the consume loop zeroes the whole box, so the buffer is all-zero again when the
// function returns. Bounding boxes above the volume cap (whole-grid greedyBoxes spans ±512 → ~2^30
// cells; arbitrary debris key sets can too) fall back to the original Set path instead.
const DENSE_MAX_VOLUME = 4_000_000;
let denseScratch = new Uint8Array(0);

/**
 * Greedy box decomposition over a set of packed voxel keys: merges runs of solid
 * voxels into a small set of boxes. Expansion stops at the set boundary, so passing
 * only one chunk's voxels yields chunk-local boxes. Deterministic: the key set is sorted
 * ascending before scanning, so the output depends only on the SET, not iteration order.
 */
export function greedyBoxesFromKeys(keys: Iterable<number>): Box[] {
  const SPAN2 = KEY_SPAN * KEY_SPAN;
  // typed-array numeric sort — keys are non-negative int32, so the order is identical to (a,b)=>a-b.
  // Duplicate input keys (the Set used to dedupe) are harmless: the seed presence check skips a
  // repeat exactly like an already-consumed voxel, so the output is unchanged.
  const sorted = Int32Array.from(keys).sort();
  const n = sorted.length;
  const boxes: Box[] = [];
  if (n === 0) return boxes;

  // Bounding box in biased key components (packKey space — no unbiasing needed for indexing).
  let minX = KEY_SPAN, maxX = -1, minY = KEY_SPAN, maxY = -1;
  for (let i = 0; i < n; i++) {
    const k = sorted[i];
    const bx = k % KEY_SPAN, by = ((k / KEY_SPAN) | 0) % KEY_SPAN;
    if (bx < minX) minX = bx;
    if (bx > maxX) maxX = bx;
    if (by < minY) minY = by;
    if (by > maxY) maxY = by;
  }
  // z is the key's highest-order component, so sorted order makes it monotonic
  const minZ = (sorted[0] / SPAN2) | 0, maxZ = (sorted[n - 1] / SPAN2) | 0;
  const dx = maxX - minX + 1, dy = maxY - minY + 1, dz = maxZ - minZ + 1;
  const volume = dx * dy * dz;
  if (volume > DENSE_MAX_VOLUME) return greedyBoxesFromKeysSet(sorted);

  const dxy = dx * dy;
  if (denseScratch.length < volume) denseScratch = new Uint8Array(volume);
  const bmp = denseScratch;
  for (let i = 0; i < n; i++) {
    const k = sorted[i];
    bmp[(k % KEY_SPAN) - minX + ((((k / KEY_SPAN) | 0) % KEY_SPAN) - minY) * dx + (((k / SPAN2) | 0) - minZ) * dxy] = 1;
  }

  // Same scan as the Set path, walking bitmap indices (+1 per x, +dx per y, +dxy per z) instead of
  // incremental keys. The bbox bound checks replace the Set's implicit stop-on-absent-key: no key
  // exists outside the bounding box, so both paths stop expansion at exactly the same cells.
  for (let i = 0; i < n; i++) {
    const k = sorted[i];
    const ix = (k % KEY_SPAN) - minX, iy = (((k / KEY_SPAN) | 0) % KEY_SPAN) - minY, iz = ((k / SPAN2) | 0) - minZ;
    const idx = ix + iy * dx + iz * dxy;
    if (bmp[idx] === 0) continue;
    const [x0, y0, z0] = unpackKey(k);

    let xs = 0;
    for (let j = idx + 1, xr = ix + 1; xr < dx && bmp[j] !== 0; j++, xr++) xs++;

    let ys = 0;
    expandY: for (let row = idx + dx, yr = iy + 1; yr < dy; row += dx, yr++) {
      for (let j = row, e = row + xs; j <= e; j++) if (bmp[j] === 0) break expandY;
      ys++;
    }

    let zs = 0;
    expandZ: for (let slab = idx + dxy, zr = iz + 1; zr < dz; slab += dxy, zr++) {
      for (let jx = slab, ex = slab + xs; jx <= ex; jx++)
        for (let jy = jx, ey = jx + ys * dx; jy <= ey; jy += dx) if (bmp[jy] === 0) break expandZ;
      zs++;
    }

    for (let jx = idx, ex = idx + xs; jx <= ex; jx++)
      for (let jy = jx, ey = jx + ys * dx; jy <= ey; jy += dx)
        for (let jz = jy, ez = jy + zs * dxy; jz <= ez; jz += dxy) bmp[jz] = 0;

    boxes.push([x0, y0, z0, x0 + xs, y0 + ys, z0 + zs]);
  }
  return boxes;
}

/** Original Set-based decomposition — the fallback for key sets whose bounding box is too large to
 *  index densely. Identical scan over the same sorted seeds, so both paths emit identical boxes. */
function greedyBoxesFromKeysSet(sorted: Int32Array): Box[] {
  const remaining = new Set<number>(sorted);
  const boxes: Box[] = [];

  // packKey is exactly linear (+1 per x, +KEY_SPAN per y, +KEY_SPAN² per z; keys < 2^31), so the
  // probe/delete loops walk incremental integer keys instead of recomputing packKey per voxel.
  const SPAN2 = KEY_SPAN * KEY_SPAN;
  for (const k of sorted) {
    if (!remaining.has(k)) continue;
    const [x0, y0, z0] = unpackKey(k);

    let x1 = x0;
    for (let kx = k + 1; remaining.has(kx); kx++) x1++;

    let y1 = y0;
    expandY: for (let rowBase = k + KEY_SPAN; ; rowBase += KEY_SPAN) {
      for (let x = x0, kx = rowBase; x <= x1; x++, kx++) if (!remaining.has(kx)) break expandY;
      y1++;
    }

    let z1 = z0;
    expandZ: for (let slabBase = k + SPAN2; ; slabBase += SPAN2) {
      for (let x = x0, kx = slabBase; x <= x1; x++, kx++)
        for (let y = y0, ky = kx; y <= y1; y++, ky += KEY_SPAN) if (!remaining.has(ky)) break expandZ;
      z1++;
    }

    for (let x = x0, kx = k; x <= x1; x++, kx++)
      for (let y = y0, ky = kx; y <= y1; y++, ky += KEY_SPAN)
        for (let z = z0, kz = ky; z <= z1; z++, kz += SPAN2) remaining.delete(kz);

    boxes.push([x0, y0, z0, x1, y1, z1]);
  }
  return boxes;
}

/** Whole-grid greedy meshing (used by tests and the perf harness). */
export function greedyBoxes(grid: VoxelGrid): Box[] {
  return greedyBoxesFromKeys(grid.keys());
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
