import { VOXEL } from "../config";
import { MATERIAL_ORDER, type MaterialId } from "./materials";

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
// CCELL === 8, integer coords in ±512 → `>> 3` is the arithmetic-shift form of Math.floor(v/8)
const cellKey = (x: number, y: number, z: number) =>
  cellOf(x >> 3, y >> 3, z >> 3);

/** Stride of the packed-key layout: keys are linear — +1 per x, +KEY_SPAN per y, +KEY_SPAN² per z. */
export const KEY_SPAN = SPAN;

export function packKey(x: number, y: number, z: number): number {
  return (x + BIAS) + (y + BIAS) * SPAN + (z + BIAS) * SPAN * SPAN;
}

export function unpackKey(key: number): [number, number, number] {
  const x = (key % SPAN) - BIAS;
  const y = (Math.floor(key / SPAN) % SPAN) - BIAS;
  const z = Math.floor(key / (SPAN * SPAN)) - BIAS;
  return [x, y, z];
}

// --- Chunked-dense storage. The world is 1024³ addressable but only ~0.1% filled, so instead of one Map
// with a JS object per voxel (~75 MB for cells + byCell + weakVoxels — the dominant heap cost, which set
// the length of every GC pause), voxels live in a Uint8Array per non-empty 32³ chunk (~10-16 MB total).
// Byte = 0 (empty) | (materialIndex+1) in bits 0‑6 | weak in bit 7. `>> 5` is the arithmetic shift form of
// Math.floor(v/32) (works for negatives); `& 31` is the matching local coordinate. ---
const SC = 32;                 // voxels per storage-chunk axis
const SC3 = SC * SC * SC;      // 32768
const scKeyOf = (x: number, y: number, z: number) => packKey(x >> 5, y >> 5, z >> 5);
const localIdx = (x: number, y: number, z: number) => (x & 31) | ((y & 31) << 5) | ((z & 31) << 10);
const MAT_BYTE = new Map<MaterialId, number>(MATERIAL_ORDER.map((m, i) => [m, i + 1])); // 1..N; 0 = empty
// Byte layout: bits 0-5 = material index (1..63 via MAT_MASK), bit 6 = INDESTRUCTIBLE, bit 7 = WEAK.
// The material field was widened-down from 7 bits to 6 (still 63 materials, we use 16) to free bit 6 for the
// indestructible flag: voxels immune to ALL gameplay destruction (the static forest wall + the gate vehicles).
const WEAK = 0x80;
export const INDESTRUCTIBLE = 0x40;
export const MAT_MASK = 0x3f;

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
  /** Material bytes, one Uint8Array(32768) per non-empty 32³ storage chunk. Freed when a chunk empties. */
  private readonly chunks = new Map<number, Uint8Array>();
  /** Voxel count per storage chunk — lets a chunk be dropped the moment it empties (destroying a building
   *  reclaims its memory) and makes chunkNonEmpty O(1). */
  private readonly chunkFill = new Map<number, number>();
  /** Voxel count per coarse 8³ cell. Replaces the old `byCell` Map<Set> (which held all 1.4M voxel refs,
   *  ~30 MB) for the has()/keys() membership the collapse solver needs; the actual voxel keys of a cell are
   *  recovered by scanning that cell's 512 bytes on demand (cellVoxelKeys). */
  private readonly cellFill = new Map<number, number>();
  private voxelCount = 0;
  /** Accumulated bullet damage per voxel; an entry only exists once a voxel is chipped. */
  private readonly damage = new Map<number, number>();
  /** Voxels deposited by settled rubble; they act as anchors so a debris pile is stable. */
  private readonly settled = new Set<number>();
  /** How many settled voxels each coarse cell holds. A settled cell is ANCHORED in the collapse solver
   *  (like the ground) so small non-structural decor — trees, lampposts, bins, litter — never registers
   *  as a "floating" cell just because it holds fewer voxels than the load-bearing mass threshold. */
  private readonly settledCells = new Map<number, number>();
  /** Cached structural (non-weak) voxel count per cell — maintained incrementally at every mutation so
   *  the collapse solver reads it in O(1) instead of re-summing every city voxel each re-solve (the
   *  dominant cost of a big collapse). */
  private readonly massByCell = new Map<number, number>();
  /** Keys of voxels DESTROYED since the last world-gen baseline — the compact "destruction diff" a late
   *  joiner needs to reconcile its pristine (seed-built) world with the room's current state. Reset by
   *  baselineGen() once world-gen finishes, so it holds only gameplay destruction, not window/door cuts. */
  readonly removedSinceGen = new Set<number>();

  get(x: number, y: number, z: number): MaterialId | undefined {
    const c = this.chunks.get(scKeyOf(x, y, z));
    if (c === undefined) return undefined;
    const b = c[localIdx(x, y, z)];
    return b === 0 ? undefined : MATERIAL_ORDER[(b & MAT_MASK) - 1];
  }

  has(x: number, y: number, z: number): boolean {
    const c = this.chunks.get(scKeyOf(x, y, z));
    return c !== undefined && c[localIdx(x, y, z)] !== 0;
  }

  /** Raw stored byte of a voxel (0 = empty): material index+1 in bits 0-5 (MAT_MASK), INDESTRUCTIBLE
   *  bit 6, WEAK bit 7. ONE Map.get + one localIdx — hot-loop form of get()+isIndestructible(). */
  byteAt(x: number, y: number, z: number): number {
    const c = this.chunks.get(scKeyOf(x, y, z));
    return c === undefined ? 0 : c[localIdx(x, y, z)];
  }

  /** MATERIAL_ORDER index of a voxel by packed key (-1 if empty) — no unpack tuple, no indexOf. */
  materialIndexAt(key: number): number {
    const [x, y, z] = unpackKey(key);
    const c = this.chunks.get(scKeyOf(x, y, z));
    return c === undefined ? -1 : (c[localIdx(x, y, z)] & MAT_MASK) - 1;
  }

  /** Whether a voxel is flagged INDESTRUCTIBLE (immune to bullets, explosions and grenades). O(1). */
  isIndestructible(x: number, y: number, z: number): boolean {
    const c = this.chunks.get(scKeyOf(x, y, z));
    return c !== undefined && (c[localIdx(x, y, z)] & INDESTRUCTIBLE) !== 0;
  }

  // --- Storage-neutral read API. External code (cook/mesh/collider/heightField/game/tests) goes through
  // these instead of touching the backing store directly, so the storage layer stays swappable. ---

  /** Packed key of every solid voxel (full scan; used by load/save/full-rebuild, NOT per-frame). Builds an
   *  array with a tight loop and returns its NATIVE iterator — NOT a generator: a generator's per-yield
   *  suspend/resume made a full mesher.rebuild() over ~1.5M voxels ~7× slower (perf.log: rebuild worstMs
   *  717 ms + a transient heap spike). The array's own iterator keeps `.next()` for callers that use it. */
  keys(): IterableIterator<number> {
    const out: number[] = [];
    for (const [sk, c] of this.chunks) {
      const [scx, scy, scz] = unpackKey(sk);
      const ox = scx * SC, oy = scy * SC, oz = scz * SC;
      for (let li = 0; li < SC3; li++) {
        if (c[li] !== 0) out.push(packKey(ox + (li & 31), oy + ((li >> 5) & 31), oz + (li >> 10)));
      }
    }
    return out.values();
  }

  /** [packedKey, material] for every solid voxel (array-backed native iterator, see keys()). */
  entries(): IterableIterator<[number, MaterialId]> {
    const out: [number, MaterialId][] = [];
    for (const [sk, c] of this.chunks) {
      const [scx, scy, scz] = unpackKey(sk);
      const ox = scx * SC, oy = scy * SC, oz = scz * SC;
      for (let li = 0; li < SC3; li++) {
        const b = c[li];
        if (b !== 0) out.push([packKey(ox + (li & 31), oy + ((li >> 5) & 31), oz + (li >> 10)), MATERIAL_ORDER[(b & MAT_MASK) - 1]]);
      }
    }
    return out.values();
  }

  /** Material of a voxel by its packed key (undefined if empty). */
  materialAt(key: number): MaterialId | undefined {
    const [x, y, z] = unpackKey(key);
    return this.get(x, y, z);
  }

  set(x: number, y: number, z: number, material: MaterialId): void {
    const sk = scKeyOf(x, y, z);
    let c = this.chunks.get(sk);
    if (c === undefined) { c = new Uint8Array(SC3); this.chunks.set(sk, c); }
    const li = localIdx(x, y, z);
    const prev = c[li];
    c[li] = MAT_BYTE.get(material)! | (prev & (WEAK | INDESTRUCTIBLE)); // overwrite material, keep weak + indestructible flags
    if (prev === 0) { // a brand-new voxel
      this.voxelCount++;
      this.chunkFill.set(sk, (this.chunkFill.get(sk) ?? 0) + 1);
      const ck = cellKey(x, y, z);
      this.cellFill.set(ck, (this.cellFill.get(ck) ?? 0) + 1);
      this.bumpMass(ck, 1); // a new (structural — new voxels are never weak) voxel adds cell mass
    }
  }

  remove(x: number, y: number, z: number): boolean {
    const sk = scKeyOf(x, y, z);
    const c = this.chunks.get(sk);
    if (c === undefined) return false;
    const li = localIdx(x, y, z);
    const b = c[li];
    if (b === 0) return false;
    const k = packKey(x, y, z);
    const ck = cellKey(x, y, z);
    if ((b & WEAK) === 0) this.bumpMass(ck, -1); // structural voxel leaves
    this.damage.delete(k);
    if (this.settled.delete(k)) this.bumpSettledCell(ck, -1);
    c[li] = 0;
    this.voxelCount--;
    const cf = (this.cellFill.get(ck) ?? 1) - 1;
    if (cf <= 0) this.cellFill.delete(ck); else this.cellFill.set(ck, cf);
    const kf = (this.chunkFill.get(sk) ?? 1) - 1;
    if (kf <= 0) { this.chunkFill.delete(sk); this.chunks.delete(sk); } else this.chunkFill.set(sk, kf);
    this.removedSinceGen.add(k); // record the destruction for late-join reconciliation
    return true;
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
    for (const ck of this.cellFill.keys()) {
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
          if (this.cellFill.has(up) && !done.has(up)) b.push(up); // cell resting on top: same overhang
        }
        if (o + 1 <= maxOverhang) {                             // lateral support from ANY reached cell, 1 overhang each
          let nb = buckets[o + 1];
          if (!nb) { nb = []; buckets[o + 1] = nb; }
          if (this.cellFill.has(ck + 1) && !done.has(ck + 1)) nb.push(ck + 1);
          if (this.cellFill.has(ck - 1) && !done.has(ck - 1)) nb.push(ck - 1);
          if (this.cellFill.has(ck + DZ) && !done.has(ck + DZ)) nb.push(ck + DZ);
          if (this.cellFill.has(ck - DZ) && !done.has(ck - DZ)) nb.push(ck - DZ);
        }
      }
    }
    const fall: number[] = [];
    for (const ck of this.cellFill.keys()) if (!done.has(ck) && !this.settledCells.has(ck)) fall.push(ck); // settled decor never "falls"
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
    for (const start of this.cellFill.keys()) {
      if (seen.has(start)) continue;
      // flood one building (connected island of cells)
      const comp: number[] = [];
      const stack = [start]; seen.add(start);
      while (stack.length) {
        const ck = stack.pop()!;
        comp.push(ck);
        for (const d of NB) { const nk = ck + d; if (this.cellFill.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); } }
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

  /** Voxel keys inside a coarse 8³ cell (so they can be removed while iterating). Scans the cell's 512
   *  bytes — the whole cell lies inside one 32³ storage chunk (8 divides 32, both grids are aligned). */
  cellVoxelKeys(ck: number): number[] {
    const cx = (ck % CELL_SPAN) - CELL_BIAS;
    const cy = (Math.floor(ck / CELL_SPAN) % CELL_SPAN) - CELL_BIAS;
    const cz = Math.floor(ck / (CELL_SPAN * CELL_SPAN)) - CELL_BIAS;
    const bx = cx * CCELL, by = cy * CCELL, bz = cz * CCELL;
    const c = this.chunks.get(packKey(bx >> 5, by >> 5, bz >> 5));
    if (c === undefined) return [];
    const out: number[] = [];
    for (let dz = 0; dz < CCELL; dz++)
      for (let dy = 0; dy < CCELL; dy++)
        for (let dx = 0; dx < CCELL; dx++) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (c[localIdx(x, y, z)] !== 0) out.push(packKey(x, y, z));
        }
    return out;
  }

  /** Cheap test of whether a 32³ collider chunk holds any voxel. A collider chunk IS one storage chunk
   *  (both 32³, 32‑aligned), and empty chunks are dropped, so presence ⟺ non-empty. O(1). */
  chunkNonEmpty(cx: number, cy: number, cz: number): boolean {
    return this.chunks.has(packKey(cx, cy, cz));
  }

  /** Voxel keys inside a chunk. `cells` = coarse 8³ cells per axis: 4 → a 32³ collider chunk (one storage
   *  chunk), 8 → a 64³ render chunk (2×2×2 storage chunks). Scans only the storage chunks that overlap the
   *  region (absent ones skipped), reconstructing keys from non-zero bytes — a cache-friendly Uint8Array
   *  walk instead of pointer-chasing Sets. */
  chunkVoxelKeys(cx: number, cy: number, cz: number, cells = 4): number[] {
    const n = (cells * CCELL) / SC; // storage chunks per axis: 1 (collider) or 2 (mesh)
    const out: number[] = [];
    for (let az = 0; az < n; az++)
      for (let ay = 0; ay < n; ay++)
        for (let ax = 0; ax < n; ax++) {
          const scx = cx * n + ax, scy = cy * n + ay, scz = cz * n + az;
          const c = this.chunks.get(packKey(scx, scy, scz));
          if (c === undefined) continue;
          const ox = scx * SC, oy = scy * SC, oz = scz * SC;
          for (let lz = 0; lz < SC; lz++) {
            const zk = oz + lz, zi = lz << 10;
            for (let ly = 0; ly < SC; ly++) {
              const yk = oy + ly, yi = (ly << 5) | zi;
              for (let lx = 0; lx < SC; lx++) if (c[lx | yi] !== 0) out.push(packKey(ox + lx, yk, zk));
            }
          }
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
    return this.voxelCount;
  }

  /** Sizes of the internal bookkeeping structures — logged to perf.log. `weak` is 0 now (folded into the
   *  material byte); `cell` is the lightweight per-cell fill count (the ~30 MB byCell Map<Set> is gone). */
  get stats(): { vox: number; rem: number; set: number; setC: number; weak: number; dmg: number; cell: number; mass: number } {
    return {
      vox: this.voxelCount, rem: this.removedSinceGen.size, set: this.settled.size,
      setC: this.settledCells.size, weak: 0, dmg: this.damage.size,
      cell: this.cellFill.size, mass: this.massByCell.size,
    };
  }

  /** Marks every EXISTING voxel in the box as NON-STRUCTURAL (a bolted-on element, e.g. an external
   *  fire-escape): it can be held up by the building, but its own cells will not anchor the structure to
   *  the ground. Called during world-gen AFTER the element's voxels are placed (the box is a generous
   *  bound over exterior air; only real voxels carry the flag). */
  markWeakBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const c = this.chunks.get(scKeyOf(x, y, z));
          if (c === undefined) continue;
          const li = localIdx(x, y, z);
          const b = c[li];
          if (b === 0 || (b & WEAK) !== 0) continue; // no voxel, or already weak
          c[li] = b | WEAK;
          this.bumpMass(cellKey(x, y, z), -1); // a structural voxel becoming weak loses its cell mass
        }
  }

  /** Flags every EXISTING voxel in the box as INDESTRUCTIBLE — immune to bullets/explosions/grenades. Used
   *  for the static forest wall + the gate's sealing vehicles. Like markWeakBox the box is a generous bound
   *  over air, so only real voxels take the flag; UNLIKE it, mass is untouched (an indestructible voxel is
   *  still present/structural — it simply can never be removed, so it also never enters the collapse solver
   *  in practice because these elements are markSettled → ground-anchored). */
  markIndestructibleBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const c = this.chunks.get(scKeyOf(x, y, z));
          if (c === undefined) continue;
          const li = localIdx(x, y, z);
          if (c[li] !== 0) c[li] |= INDESTRUCTIBLE;
        }
  }

  clear(): void {
    this.chunks.clear();
    this.chunkFill.clear();
    this.cellFill.clear();
    this.voxelCount = 0;
    this.damage.clear();
    this.settled.clear();
    this.settledCells.clear();
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
