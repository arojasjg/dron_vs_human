import { VOXEL } from "../config";
import type { MaterialId } from "./materials";

const BIAS = 512;
const BITS = 10;
const SPAN = 1 << BITS;

// 3D cell index: groups voxel keys by a coarse 8³ (2m) cell. Used both for collider streaming and
// as the COARSE STRUCTURAL GRAPH — support is solved over these cells (thousands), not voxels
// (millions), so a whole-building collapse costs ~ms and the load redistributes by 2m blocks.
const CCELL = 8;
const CELL_BIAS = 512;
const CELL_SPAN = CELL_BIAS * 2;
const cellOf = (cx: number, cy: number, cz: number) =>
  (cx + CELL_BIAS) + (cy + CELL_BIAS) * CELL_SPAN + (cz + CELL_BIAS) * CELL_SPAN * CELL_SPAN;
const cellKey = (x: number, y: number, z: number) =>
  cellOf(Math.floor(x / CCELL), Math.floor(y / CCELL), Math.floor(z / CCELL));

export function packKey(x: number, y: number, z: number): number {
  return (x + BIAS) + (y + BIAS) * SPAN + (z + BIAS) * SPAN * SPAN;
}

export function unpackKey(key: number): [number, number, number] {
  const x = (key % SPAN) - BIAS;
  const y = (Math.floor(key / SPAN) % SPAN) - BIAS;
  const z = Math.floor(key / (SPAN * SPAN)) - BIAS;
  return [x, y, z];
}

export interface RayHit {
  /** Voxel that was hit. */
  vx: number;
  vy: number;
  vz: number;
  /** World-space entry point. */
  point: { x: number; y: number; z: number };
  /** Face normal of the entered voxel (points back toward the ray origin). */
  normal: { x: number; y: number; z: number };
  distance: number;
  material: MaterialId;
}

export class VoxelGrid {
  readonly cells = new Map<number, MaterialId>();
  /** Accumulated bullet damage per voxel; an entry only exists once a voxel is chipped. */
  private readonly damage = new Map<number, number>();
  /** Voxels deposited by settled rubble; they act as anchors so a debris pile is stable. */
  private readonly settled = new Set<number>();
  /** Non-load-bearing voxels (bolted-on fire-escapes): supported BY the building but never a ground
   *  ANCHOR themselves, so a thin fire-escape can't float a building whose real structure is gone. */
  private readonly weakVoxels = new Set<number>();
  /** 3D cell index (coarse cell → voxel keys) for fast regional collection. */
  private readonly byCell = new Map<number, Set<number>>();

  get(x: number, y: number, z: number): MaterialId | undefined {
    return this.cells.get(packKey(x, y, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.cells.has(packKey(x, y, z));
  }

  set(x: number, y: number, z: number, material: MaterialId): void {
    const k = packKey(x, y, z);
    this.cells.set(k, material);
    const ck = cellKey(x, y, z);
    let s = this.byCell.get(ck);
    if (!s) { s = new Set(); this.byCell.set(ck, s); }
    s.add(k);
  }

  remove(x: number, y: number, z: number): boolean {
    const k = packKey(x, y, z);
    this.damage.delete(k);
    this.settled.delete(k);
    this.weakVoxels.delete(k);
    const ck = cellKey(x, y, z);
    const s = this.byCell.get(ck);
    if (s) { s.delete(k); if (s.size === 0) this.byCell.delete(ck); }
    return this.cells.delete(k);
  }

  /** Collects solid voxels inside the box [x0,x1]×[y0,y1]×[z0,z1]. */
  /**
   * COARSE STRUCTURAL SOLVE over the cell graph: support starts at ground cells (cy 0) and travels
   * up (weight 0) and sideways (weight 1, up to maxOverhang cells). Returns the keys of every solid
   * cell with no such path to the ground — i.e. the cells whose voxels must fall. O(solid cells),
   * so it's a few ms for the whole building and runs globally (no region/perimeter approximation,
   * so no false floaters), and load redistributes to neighbouring column-cells (local collapse).
   */
  fallenCells(maxOverhang: number): number[] {
    const DY = CELL_SPAN, DZ = CELL_SPAN * CELL_SPAN;
    const buckets: number[][] = [[]];
    for (const [ck, vox] of this.byCell) {
      const cy = Math.floor(ck / CELL_SPAN) % CELL_SPAN - CELL_BIAS;
      if (cy !== 0) continue;
      // a bolted-on cell (all voxels weak, e.g. a lone fire-escape) is NOT a ground anchor
      let structural = false;
      for (const k of vox) if (!this.weakVoxels.has(k)) { structural = true; break; }
      if (structural) buckets[0].push(ck); // ground-level structural cell
    }
    const done = new Set<number>();
    for (let o = 0; o <= maxOverhang; o++) {
      const b = buckets[o];
      if (!b) continue;
      for (let i = 0; i < b.length; i++) {
        const ck = b[i];
        if (done.has(ck)) continue;
        done.add(ck);
        const up = ck + DY;
        if (this.byCell.has(up) && !done.has(up)) b.push(up); // cell resting on top: same overhang
        if (o + 1 <= maxOverhang) {
          let nb = buckets[o + 1];
          if (!nb) { nb = []; buckets[o + 1] = nb; }
          if (this.byCell.has(ck + 1) && !done.has(ck + 1)) nb.push(ck + 1);
          if (this.byCell.has(ck - 1) && !done.has(ck - 1)) nb.push(ck - 1);
          if (this.byCell.has(ck + DZ) && !done.has(ck + DZ)) nb.push(ck + DZ);
          if (this.byCell.has(ck - DZ) && !done.has(ck - DZ)) nb.push(ck - DZ);
        }
      }
    }
    const fall: number[] = [];
    for (const ck of this.byCell.keys()) if (!done.has(ck)) fall.push(ck);
    return fall;
  }

  /** Snapshot of the voxel keys inside a coarse cell (so they can be removed while iterating). */
  cellVoxelKeys(cellKey: number): number[] {
    const s = this.byCell.get(cellKey);
    return s ? [...s] : [];
  }

  /** Cheap test of whether a 32³ collider chunk holds any voxel (32/8 = 4 cells per axis). */
  chunkNonEmpty(cx: number, cy: number, cz: number): boolean {
    const bx = cx * 4, by = cy * 4, bz = cz * 4;
    for (let dx = 0; dx < 4; dx++)
      for (let dy = 0; dy < 4; dy++)
        for (let dz = 0; dz < 4; dz++)
          if (this.byCell.has(cellOf(bx + dx, by + dy, bz + dz))) return true;
    return false;
  }

  /** Adds one hit of bullet damage to a voxel and returns its new accumulated total. */
  addDamage(x: number, y: number, z: number): number {
    const k = packKey(x, y, z);
    const d = (this.damage.get(k) ?? 0) + 1;
    this.damage.set(k, d);
    return d;
  }

  /** Marks a voxel as settled rubble (an anchor for support, like the ground). */
  markSettled(x: number, y: number, z: number): void {
    this.settled.add(packKey(x, y, z));
  }

  isSettled(x: number, y: number, z: number): boolean {
    return this.settled.has(packKey(x, y, z));
  }

  isSettledKey(key: number): boolean {
    return this.settled.has(key);
  }

  get size(): number {
    return this.cells.size;
  }

  /** Marks every voxel in the box as NON-STRUCTURAL (a bolted-on element, e.g. an external fire-escape):
   *  it can be held up by the building, but its own cells will not anchor the structure to the ground. */
  markWeakBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
      this.weakVoxels.add(packKey(x, y, z));
  }

  clear(): void {
    this.cells.clear();
    this.damage.clear();
    this.settled.clear();
    this.weakVoxels.clear();
    this.byCell.clear();
  }

  /** World-space center of a voxel. */
  static center(x: number, y: number, z: number): { x: number; y: number; z: number } {
    return { x: (x + 0.5) * VOXEL, y: (y + 0.5) * VOXEL, z: (z + 0.5) * VOXEL };
  }

  static worldToVoxel(x: number, y: number, z: number): [number, number, number] {
    return [Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL)];
  }

  /**
   * Amanatides-Woo voxel traversal. Returns the first solid voxel hit, with the
   * exact world entry point and face normal so holes form precisely at impact.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): RayHit | null {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    let vx = Math.floor(ox / VOXEL);
    let vy = Math.floor(oy / VOXEL);
    let vz = Math.floor(oz / VOXEL);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    const tDeltaX = dx !== 0 ? Math.abs(VOXEL / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(VOXEL / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(VOXEL / dz) : Infinity;

    const nextBoundary = (v: number, step: number) => (step > 0 ? (v + 1) * VOXEL : v * VOXEL);
    let tMaxX = dx !== 0 ? (nextBoundary(vx, stepX) - ox) / dx : Infinity;
    let tMaxY = dy !== 0 ? (nextBoundary(vy, stepY) - oy) / dy : Infinity;
    let tMaxZ = dz !== 0 ? (nextBoundary(vz, stepZ) - oz) / dz : Infinity;

    let normal = { x: 0, y: 0, z: 0 };
    let t = 0;

    for (let i = 0; i < 4096; i++) {
      const mat = this.get(vx, vy, vz);
      if (mat !== undefined) {
        return {
          vx, vy, vz,
          point: { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t },
          normal,
          distance: t,
          material: mat,
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        vx += stepX; t = tMaxX; tMaxX += tDeltaX;
        normal = { x: -stepX, y: 0, z: 0 };
      } else if (tMaxY < tMaxZ) {
        vy += stepY; t = tMaxY; tMaxY += tDeltaY;
        normal = { x: 0, y: -stepY, z: 0 };
      } else {
        vz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        normal = { x: 0, y: 0, z: -stepZ };
      }
      if (t > maxDist) return null;
    }
    return null;
  }
}
