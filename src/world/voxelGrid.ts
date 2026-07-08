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
  /** How many settled voxels each coarse cell holds. A settled cell is ANCHORED in the collapse solver
   *  (like the ground) so small non-structural decor — trees, lampposts, bins, litter — never registers
   *  as a "floating" cell just because it holds fewer voxels than the load-bearing mass threshold. */
  private readonly settledCells = new Map<number, number>();
  /** Non-load-bearing voxels (bolted-on fire-escapes): supported BY the building but never a ground
   *  ANCHOR themselves, so a thin fire-escape can't float a building whose real structure is gone. */
  private readonly weakVoxels = new Set<number>();
  /** 3D cell index (coarse cell → voxel keys) for fast regional collection. */
  private readonly byCell = new Map<number, Set<number>>();
  /** Cached structural (non-weak) voxel count per cell — maintained incrementally at every mutation so
   *  the collapse solver reads it in O(1) instead of re-summing every city voxel each re-solve (the
   *  dominant cost of a big collapse). Invariant: massByCell[ck] == |byCell[ck] \ weakVoxels|. */
  private readonly massByCell = new Map<number, number>();
  /** Keys of voxels DESTROYED since the last world-gen baseline — the compact "destruction diff" a late
   *  joiner needs to reconcile its pristine (seed-built) world with the room's current state. Reset by
   *  baselineGen() once world-gen finishes, so it holds only gameplay destruction, not window/door cuts. */
  readonly removedSinceGen = new Set<number>();

  get(x: number, y: number, z: number): MaterialId | undefined {
    return this.cells.get(packKey(x, y, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.cells.has(packKey(x, y, z));
  }

  set(x: number, y: number, z: number, material: MaterialId): void {
    const k = packKey(x, y, z);
    const isNew = !this.cells.has(k);
    this.cells.set(k, material);
    const ck = cellKey(x, y, z);
    let s = this.byCell.get(ck);
    if (!s) { s = new Set(); this.byCell.set(ck, s); }
    s.add(k);
    if (isNew && !this.weakVoxels.has(k)) this.bumpMass(ck, 1); // a new structural voxel adds cell mass
  }

  remove(x: number, y: number, z: number): boolean {
    const k = packKey(x, y, z);
    const ck = cellKey(x, y, z);
    if (this.cells.has(k) && !this.weakVoxels.has(k)) this.bumpMass(ck, -1); // structural voxel leaves
    this.damage.delete(k);
    if (this.settled.delete(k)) this.bumpSettledCell(ck, -1);
    this.weakVoxels.delete(k);
    const s = this.byCell.get(ck);
    if (s) { s.delete(k); if (s.size === 0) this.byCell.delete(ck); }
    const existed = this.cells.delete(k);
    if (existed) this.removedSinceGen.add(k); // record the destruction for late-join reconciliation
    return existed;
  }

  /** Marks the current grid as the world-gen baseline: forget window/door cuts so removedSinceGen
   *  accumulates only real gameplay destruction from here on. Called once world-gen completes. */
  baselineGen(): void { this.removedSinceGen.clear(); }

  private bumpMass(ck: number, delta: number): void {
    const m = (this.massByCell.get(ck) ?? 0) + delta;
    if (m <= 0) this.massByCell.delete(ck); else this.massByCell.set(ck, m);
  }

  private bumpSettledCell(ck: number, delta: number): void {
    const m = (this.settledCells.get(ck) ?? 0) + delta;
    if (m <= 0) this.settledCells.delete(ck); else this.settledCells.set(ck, m);
  }

  /** Cached structural voxel count of a coarse cell (non-weak voxels). O(1). */
  cellMass(ck: number): number { return this.massByCell.get(ck) ?? 0; }

  /** Collects solid voxels inside the box [x0,x1]×[y0,y1]×[z0,z1]. */
  /**
   * COARSE STRUCTURAL SOLVE over the cell graph: support starts at ground cells (cy 0) and travels
   * up (weight 0) and sideways (weight 1, up to maxOverhang cells). Returns the keys of every solid
   * cell with no such path to the ground — i.e. the cells whose voxels must fall. O(solid cells),
   * so it's a few ms for the whole building and runs globally (no region/perimeter approximation,
   * so no false floaters), and load redistributes to neighbouring column-cells (local collapse).
   *
   * `minCellMass` is the load-bearing threshold: a 2m cell must hold at least this many STRUCTURAL
   * (non-weak) voxels to anchor at the ground OR to carry support onward. A blast that whittles a
   * column down to a thin sliver leaves the cell "present" but sub-threshold, so it can no longer
   * hold the floors above — they lose their path to the ground and collapse. (0 = the old behaviour:
   * any single voxel bears a whole tower, which left buildings floating on one block.) A thin cell can
   * still be REACHED and stay standing itself (e.g. a parapet resting on a full wall); it just can't
   * pass load further, so decoration doesn't fall but slivers can't suspend mass above them.
   */
  fallenCells(maxOverhang: number, minCellMass = 0): number[] {
    const DY = CELL_SPAN, DZ = CELL_SPAN * CELL_SPAN;
    // a cell bears load only if its (cached) structural voxel count clears minCellMass
    const bears = (ck: number) => { const m = this.cellMass(ck); return m > 0 && m >= minCellMass; };
    // a settled cell (parked/decor props, settled rubble) is ANCHORED like the ground — it never falls and
    // it can pass support on — so small non-structural decor isn't flagged just for being below the mass floor.
    const anchored = (ck: number) => this.settledCells.has(ck) || bears(ck);

    const buckets: number[][] = [[]];
    for (const [ck] of this.byCell) {
      const cy = Math.floor(ck / CELL_SPAN) % CELL_SPAN - CELL_BIAS;
      if (cy !== 0) continue;
      if (anchored(ck)) buckets[0].push(ck); // ground-level anchor (load-bearing mass OR settled decor)
    }
    const done = new Set<number>();
    for (let o = 0; o <= maxOverhang; o++) {
      const b = buckets[o];
      if (!b) continue;
      for (let i = 0; i < b.length; i++) {
        const ck = b[i];
        if (done.has(ck)) continue;
        done.add(ck);
        // Only a cell that clears the mass floor can hold the STOREY DIRECTLY ABOVE it — this is what
        // stops a whittled sliver from suspending a tower (minCellMass). But a thin cell STILL holds its
        // lateral neighbours (attached structure — a wall corner, a 1-voxel edge slice at a cell boundary),
        // so an intact building's boundary slivers don't false-fall.
        if (anchored(ck)) {
          const up = ck + DY;
          if (this.byCell.has(up) && !done.has(up)) b.push(up); // cell resting on top: same overhang
        }
        if (o + 1 <= maxOverhang) {                             // lateral support from ANY reached cell, 1 overhang each
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
    for (const ck of this.byCell.keys()) if (!done.has(ck) && !this.settledCells.has(ck)) fall.push(ck); // settled decor never "falls"
    return fall;
  }

  /**
   * PANCAKE pass: topological support (fallenCells) keeps a floor up as long as ANY thread reaches the
   * ground, so blasting out the middle of a lower storey leaves the intact upper floors "floating" on
   * the surviving perimeter. This models the load side: within each building (a connected cell island),
   * a storey that's been gutted below what it must carry can't hold the floors above — they pancake down.
   *
   * For each building component, per cell-Y level count the bearing cross-section `area[cy]`. A level is
   * a PINCH if `area[cy] < frac × maxAreaAbove` — i.e. there's much more building resting on it than it
   * has section to bear. Everything above the LOWEST pinch collapses. Comparing to the mass ABOVE (not a
   * fixed footprint) is what separates damage from a natural taper: an intact building narrows going up,
   * so a level is never dwarfed by what's above it → no pinch → nothing falls.
   */
  pancakeCells(minCellMass: number, frac: number): number[] {
    const DY = CELL_SPAN, DZ = CELL_SPAN * CELL_SPAN;
    const cyOf = (ck: number) => Math.floor(ck / CELL_SPAN) % CELL_SPAN - CELL_BIAS;
    const bears = (ck: number) => { const m = this.cellMass(ck); return m >= minCellMass && m > 0; };
    const NB = [1, -1, DY, -DY, DZ, -DZ];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const start of this.byCell.keys()) {
      if (seen.has(start)) continue;
      // flood one building (connected island of cells)
      const comp: number[] = [];
      const stack = [start]; seen.add(start);
      while (stack.length) {
        const ck = stack.pop()!;
        comp.push(ck);
        for (const d of NB) { const nk = ck + d; if (this.byCell.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); } }
      }
      // bearing cross-section per level
      const area = new Map<number, number>();
      for (const ck of comp) if (bears(ck)) area.set(cyOf(ck), (area.get(cyOf(ck)) ?? 0) + 1);
      if (area.size < 2) continue;
      const cys = [...area.keys()].sort((a, b) => a - b);
      // lowest level whose section is dwarfed by the mass resting above it
      let pinchCy: number | null = null;
      for (let i = 0; i < cys.length - 1; i++) {
        let maxAbove = 0;
        for (let j = i + 1; j < cys.length; j++) { const a = area.get(cys[j])!; if (a > maxAbove) maxAbove = a; }
        if (area.get(cys[i])! < frac * maxAbove) { pinchCy = cys[i]; break; }
      }
      if (pinchCy === null) continue;
      for (const ck of comp) if (cyOf(ck) > pinchCy) out.push(ck); // the storeys above the pinch pancake
    }
    return out;
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

  /** Voxel keys inside a chunk, gathered from the coarse 8-voxel cell index (`cells` cells per axis).
   *  Default 4 → a 32³ collider chunk (32/8); pass 8 for a 64³ render chunk (see meshChunkVoxelKeys).
   *  O(voxels present), not O(chunk volume) — a carved/sparse chunk costs a handful of Set walks instead
   *  of tens of thousands of hash probes, which is the hot path of rebuilds during destruction. */
  chunkVoxelKeys(cx: number, cy: number, cz: number, cells = 4): number[] {
    const bx = cx * cells, by = cy * cells, bz = cz * cells;
    const out: number[] = [];
    for (let dx = 0; dx < cells; dx++)
      for (let dy = 0; dy < cells; dy++)
        for (let dz = 0; dz < cells; dz++) {
          const s = this.byCell.get(cellOf(bx + dx, by + dy, bz + dz));
          if (s) for (const k of s) out.push(k);
        }
    return out;
  }

  /** Voxel keys inside a 64³ RENDER chunk (MESH_CHUNK/CCELL = 8 cells per axis). */
  meshChunkVoxelKeys(cx: number, cy: number, cz: number): number[] {
    return this.chunkVoxelKeys(cx, cy, cz, 8);
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
    const k = packKey(x, y, z);
    if (!this.settled.has(k)) { this.settled.add(k); this.bumpSettledCell(cellKey(x, y, z), 1); }
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
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = packKey(x, y, z);
      // an existing structural voxel becoming weak loses its cell mass
      if (this.cells.has(k) && !this.weakVoxels.has(k)) this.bumpMass(cellKey(x, y, z), -1);
      this.weakVoxels.add(k);
    }
  }

  clear(): void {
    this.cells.clear();
    this.damage.clear();
    this.settled.clear();
    this.settledCells.clear();
    this.weakVoxels.clear();
    this.byCell.clear();
    this.massByCell.clear();
    this.removedSinceGen.clear();
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
