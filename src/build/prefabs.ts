import type { MaterialId } from "../world/materials";
import type { VoxelGrid } from "../world/voxelGrid";
import { Rng, mix32 } from "../engine/rng";
import { VOXEL } from "../config";

// Seeded PRNG (mulberry32) so every client in a multiplayer room generates the IDENTICAL building —
// the foundation of full destruction sync. setWorldSeed() is called from the room code before build.
let _seed = 0x9e3779b9;
export function setWorldSeed(seed: number): void { _seed = (seed >>> 0) || 1; }
function rand(): number {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function fillBox(
  grid: VoxelGrid,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  mat: MaterialId,
): void {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) grid.set(x, y, z, mat);
}

function clearBox(
  grid: VoxelGrid,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): void {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) grid.remove(x, y, z);
}

/** Brick house with a concrete floor, glass windows, a door opening and a wooden roof. */
export function buildHouse(grid: VoxelGrid, ox = 0, oz = 0): void {
  const W = 16, D = 14, H = 12;
  // floor
  fillBox(grid, ox, ox + W - 1, 0, 0, oz, oz + D - 1, "concrete");
  // four walls (brick), 1 voxel thick
  fillBox(grid, ox, ox + W - 1, 1, H, oz, oz, "brick");
  fillBox(grid, ox, ox + W - 1, 1, H, oz + D - 1, oz + D - 1, "brick");
  fillBox(grid, ox, ox, 1, H, oz, oz + D - 1, "brick");
  fillBox(grid, ox + W - 1, ox + W - 1, 1, H, oz, oz + D - 1, "brick");
  // wooden roof
  fillBox(grid, ox, ox + W - 1, H + 1, H + 1, oz, oz + D - 1, "wood");

  // door (front wall, z = oz) — 2 m clear (y1..8) so a 1.7 m soldier (head ~1.95 m) walks straight through
  clearBox(grid, ox + 6, ox + 9, 1, 8, oz, oz);
  // glass windows on the side walls
  fillBox(grid, ox, ox, 5, 8, oz + 3, oz + 5, "glass");
  fillBox(grid, ox, ox, 5, 8, oz + 8, oz + 10, "glass");
  fillBox(grid, ox + W - 1, ox + W - 1, 5, 8, oz + 3, oz + 5, "glass");
  fillBox(grid, ox + W - 1, ox + W - 1, 5, 8, oz + 8, oz + 10, "glass");
  // glass transom above the door (y9..10, clear of the taller opening) + back window
  fillBox(grid, ox + 6, ox + 9, 9, 10, oz, oz, "glass");
  fillBox(grid, ox + 6, ox + 9, 5, 9, oz + D - 1, oz + D - 1, "glass");
}

/** Free-standing thick wall — the classic "open a hole anywhere" target. */
export function buildWall(grid: VoxelGrid, ox = 22, oz = 4): void {
  fillBox(grid, ox, ox + 23, 0, 13, oz, oz + 1, "brick");
  // a concrete band so the lower third resists more than the upper bricks
  fillBox(grid, ox, ox + 23, 0, 2, oz, oz + 1, "concrete");
}

/** Tall concrete column — cut its base and the top topples (structural integrity demo). */
export function buildTower(grid: VoxelGrid, ox = -12, oz = 4): void {
  fillBox(grid, ox, ox + 3, 0, 39, oz, oz + 3, "concrete");
}

// A vehicle is a standalone prop, not load-bearing structure: mark every voxel non-structural so its
// body (cantilevered over the wheels) isn't treated as "floating" and doesn't force a huge overhang
// budget on the whole world.
function markSettledBox(grid: VoxelGrid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
    if (grid.has(x, y, z)) grid.markSettled(x, y, z);
}

/** Static destructible sedan: painted body + raised cabin + glass greenhouse + rubber tyres + lights. */
export function buildCar(grid: VoxelGrid, ox = 2, oz = -9, paint: MaterialId = "car_red"): void {
  fillBox(grid, ox, ox + 13, 1, 2, oz, oz + 6, paint);          // chassis / lower body
  fillBox(grid, ox, ox + 3, 3, 3, oz, oz + 6, paint);           // hood (front, low)
  fillBox(grid, ox + 10, ox + 13, 3, 3, oz, oz + 6, paint);     // trunk (rear, low)
  fillBox(grid, ox + 4, ox + 9, 3, 5, oz, oz + 6, paint);       // raised cabin
  fillBox(grid, ox + 4, ox + 9, 4, 5, oz, oz, "glass");         // side windows
  fillBox(grid, ox + 4, ox + 9, 4, 5, oz + 6, oz + 6, "glass");
  fillBox(grid, ox + 4, ox + 4, 4, 5, oz + 1, oz + 5, "glass"); // windshield
  fillBox(grid, ox + 9, ox + 9, 4, 5, oz + 1, oz + 5, "glass"); // rear window
  for (const [wx, wz] of [[ox + 1, oz], [ox + 1, oz + 6], [ox + 11, oz], [ox + 11, oz + 6]] as const)
    fillBox(grid, wx, wx + 1, 0, 1, wz, wz, "tire");            // tyres
  fillBox(grid, ox, ox, 2, 2, oz + 1, oz + 1, "glass"); fillBox(grid, ox, ox, 2, 2, oz + 5, oz + 5, "glass"); // headlights
  markSettledBox(grid, ox, ox + 13, 0, 5, oz, oz + 6);
}

/** Box truck: painted cab + tall steel cargo box on six tyres. */
export function buildTruck(grid: VoxelGrid, ox = 0, oz = 0, paint: MaterialId = "car_blue"): void {
  fillBox(grid, ox, ox + 18, 1, 2, oz, oz + 7, "metal");        // chassis
  fillBox(grid, ox, ox + 5, 1, 6, oz, oz + 7, paint);          // cab
  fillBox(grid, ox, ox, 4, 6, oz + 1, oz + 6, "glass");        // windshield
  fillBox(grid, ox + 1, ox + 5, 5, 6, oz, oz, "glass"); fillBox(grid, ox + 1, ox + 5, 5, 6, oz + 7, oz + 7, "glass");
  fillBox(grid, ox + 6, ox + 18, 1, 8, oz, oz + 7, "metal");    // cargo box
  for (const wx of [ox + 2, ox + 13, ox + 16]) for (const wz of [oz, oz + 7]) fillBox(grid, wx, wx + 1, 0, 1, wz, wz, "tire");
  markSettledBox(grid, ox, ox + 18, 0, 8, oz, oz + 7);
}

/** Boxy delivery van: tall painted body + wraparound glass + tyres. */
export function buildVan(grid: VoxelGrid, ox = 0, oz = 0, paint: MaterialId = "car_teal"): void {
  fillBox(grid, ox, ox + 11, 1, 7, oz, oz + 6, paint);         // body
  fillBox(grid, ox, ox, 4, 6, oz + 1, oz + 5, "glass");        // windshield
  fillBox(grid, ox + 1, ox + 3, 5, 6, oz, oz, "glass"); fillBox(grid, ox + 1, ox + 3, 5, 6, oz + 6, oz + 6, "glass"); // cab windows
  for (const [wx, wz] of [[ox + 1, oz], [ox + 1, oz + 6], [ox + 9, oz], [ox + 9, oz + 6]] as const)
    fillBox(grid, wx, wx + 1, 0, 1, wz, wz, "tire");
  markSettledBox(grid, ox, ox + 11, 0, 7, oz, oz + 6);
}

/** A small gas tank (cluster of explosive voxels) standing on the floor at (x,y,z). */
export function placeGasTank(grid: VoxelGrid, x: number, y: number, z: number): void {
  fillBox(grid, x, x + 1, y, y + 4, z, z + 1, "gastank");
}

// ---- Street dressing: small destructible voxel props (all markSettled → non-structural) -------------

export type TreeKind = "oak" | "pine" | "bush";
/** A destructible tree in one of three seeded shapes (canopy is weak foliage → a single hit knocks it
 *  apart): OAK (round broadleaf, the original), PINE (tall conifer with a stacked conical dark-needle
 *  canopy), BUSH (low leafy shrub). `kind` defaults to a position hash so a street/forest gets natural
 *  variety with no extra caller work; all shapes are markSettled (non-structural). Deterministic. */
export function buildTree(grid: VoxelGrid, ox: number, oz: number, kind?: TreeKind, indestructible = false): void {
  const hsh = mix32(ox, oz);
  const k: TreeKind = kind ?? (["oak", "pine", "oak", "bush", "pine"] as const)[hsh % 5]; // oak/pine common, bush rarer
  // A tree is DECORATION, not structure: mark its bound BOTH weak (dropped from the collapse/pancake mass
  // solve — a dense row of trees, e.g. a boulevard median or the forest wall, must never register as a
  // load-bearing storey and false-pancake) and settled (anchored, so it never counts as a floating cell).
  // Forest-wall trees additionally take the INDESTRUCTIBLE flag (immune to every weapon).
  const mark = (x0: number, x1: number, y1: number, z0: number, z1: number): void => {
    grid.markWeakBox(x0, x1, 0, y1, z0, z1);
    markSettledBox(grid, x0, x1, 0, y1, z0, z1);
    if (indestructible) grid.markIndestructibleBox(x0, x1, 0, y1, z0, z1);
  };

  if (k === "bush") {                                        // low leafy shrub — a short stem + small blob
    grid.set(ox, 0, oz, "wood");
    const R = 1, cy = 1;
    for (let dx = -R; dx <= R; dx++)
      for (let dy = 0; dy <= R + 1; dy++)
        for (let dz = -R; dz <= R; dz++)
          if (dx * dx + (dy - 1) * (dy - 1) + dz * dz <= R * R + 1) grid.set(ox + dx, cy + dy, oz + dz, "leaves");
    mark(ox - R, ox + R, cy + R + 1, oz - R, oz + R);
    return;
  }

  if (k === "pine") {                                        // tall conifer — narrowing conical needle canopy
    const h = 6 + (hsh % 4);                                 // trunk 6..9
    for (let y = 0; y < h; y++) grid.set(ox, y, oz, "wood");
    let R = 3;
    for (let y = h; y <= h + 6 && R >= 0; y++) {
      for (let dx = -R; dx <= R; dx++)
        for (let dz = -R; dz <= R; dz++)
          if (dx * dx + dz * dz <= R * R + 1) grid.set(ox + dx, y, oz + dz, "leaves_pine");
      if ((y - h) % 2 === 1) R--;                            // shrink every other ring → a point at the top
    }
    mark(ox - 3, ox + 3, h + 6, oz - 3, oz + 3);
    return;
  }

  const h = 5 + (hsh % 3);                                   // OAK: trunk height 5..7, hashed by position
  for (let y = 0; y < h; y++) grid.set(ox, y, oz, "wood");
  grid.set(ox, h, oz, "leaves");                             // neck: canopy sits on the trunk top
  const cy = h + 1, R = 2;
  for (let dx = -R; dx <= R; dx++)
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        if (dx * dx + dy * dy + dz * dz <= R * R + 1) grid.set(ox + dx, cy + dy, oz + dz, "leaves");
  mark(ox - R, ox + R, cy + R, oz - R, oz + R);
}

/** A street lamp: a metal pole with a short arm and a glowing glass lamp head. */
export function buildLamppost(grid: VoxelGrid, ox: number, oz: number): void {
  const h = 6;
  for (let y = 0; y <= h; y++) grid.set(ox, y, oz, "metal");  // pole
  grid.set(ox + 1, h, oz, "metal");                            // arm
  grid.set(ox + 1, h - 1, oz, "glass");                        // lamp head
  markSettledBox(grid, ox, ox + 1, 0, h, oz, oz);
}

/** A small metal trash can (2×2 footprint, waist-high). */
export function buildTrashCan(grid: VoxelGrid, ox: number, oz: number): void {
  fillBox(grid, ox, ox + 1, 0, 2, oz, oz + 1, "metal");
  markSettledBox(grid, ox, ox + 1, 0, 2, oz, oz + 1);
}

/** A little scatter of litter on the pavement — 2-4 tiny bits of mixed material, hashed by position. */
export function buildLitter(grid: VoxelGrid, ox: number, oz: number): void {
  const bits: MaterialId[] = ["wood", "glass", "metal"];
  const s = mix32(ox, oz, 0x11);
  const n = 2 + (s % 3);
  for (let i = 0; i < n; i++) {
    const hx = mix32(s, i), hz = mix32(s, i, 7);
    grid.set(ox + (hx % 3) - 1, 0, oz + (hz % 3) - 1, bits[hx % bits.length]); // within ±1 voxel
  }
  markSettledBox(grid, ox - 1, ox + 1, 0, 0, oz - 1, oz + 1);
}

/**
 * Multi-storey building with real interiors: concrete floor slabs, brick exterior +
 * interior dividing walls with doorways, glass windows, a stairwell hole between
 * floors, a roof, and gas tanks placed inside each storey.
 */
// Building layout — exported so the player can be spawned inside the ground-floor lobby.
// BIG is the DEFAULT single-building spec (used by buildBuilding when no size is given). The town grid
// no longer derives from it — plot size is its own source of truth (PLOT_W/PLOT_D below).
export const BIG = { W: 346, D: 270, H: 18, FLOORS: 6 };
/** Per-building size. Storey height (H) is fixed to BIG.H so STRIDE stays constant everywhere. */
export interface BuildSpec { W: number; D: number; FLOORS: number }
const STRIDE = BIG.H + 1;        // voxels between floor slabs
const COL = 14;                  // structural column spacing (≈50% fewer columns than before)
const ROOM_BAYS = 2;             // upper-floor rooms span this many column bays →
const ROOM = ROOM_BAYS * COL;    // big rooms (~28 voxels) whose walls fall on column lines
// Door opening height in voxels (from the floor up). The human capsule is ~1.7 m (6.8 voxels) plus a
// collision skin, so 7 voxels (1.75 m) jammed it — 9 voxels (2.25 m) gives real head clearance.
export const DOOR_TOP = 9;
const STAIR_LANE = 3;            // width (x) of ONE stair lane — fits a ~0.6 m capsule with margin
const STAIR_W = STAIR_LANE * 2;  // shaft holds two side-by-side lanes for the switch-back
// Stairwell inset from the SW corner. The Z inset is the key: the ground flight's low end (where you
// board) must sit far enough off the south wall that a ~0.6 m capsule has room to stand and step on.
const STAIR_X_INSET = 3, STAIR_Z_INSET = 5;
/** The stair shaft's voxel bounds for a building at (ox,oz) — the single source of truth shared by
 *  the flights, the per-floor holes, the roof exit and the boarding-clearance test. */
export function stairShaft(ox = 0, oz = 0): { x0: number; x1: number; z0: number; z1: number } {
  const x0 = ox + STAIR_X_INSET, z0 = oz + STAIR_Z_INSET;
  return { x0, x1: x0 + STAIR_W - 1, z0, z1: z0 + STRIDE - 1 };
}

/** Structural columns from the ground up to the roof, on a grid — these carry the slabs so
 *  rooms and the lobby can be wide open without the ceilings cantilevering / floating. */
function buildColumns(grid: VoxelGrid, ox: number, oz: number, spec: BuildSpec): void {
  const topY = spec.FLOORS * STRIDE;
  for (let cx = ox + COL; cx < ox + spec.W - 3; cx += COL)
    for (let cz = oz + COL; cz < oz + spec.D - 3; cz += COL)
      fillBox(grid, cx, cx + 1, 0, topY, cz, cz + 1, "concrete"); // 2×2 pillar
}

/** Beams under a storey's ceiling, linking the columns. They give the slab above linear
 *  support (not just point support at the columns), so it only spans ~COL/2 between beams. */
function buildBeams(grid: VoxelGrid, ox: number, oz: number, top: number, spec: BuildSpec): void {
  for (let cz = oz + COL; cz < oz + spec.D - 3; cz += COL)
    fillBox(grid, ox, ox + spec.W - 1, top, top, cz, cz + 1, "concrete");
  for (let cx = ox + COL; cx < ox + spec.W - 3; cx += COL)
    fillBox(grid, cx, cx + 1, top, top, oz, oz + spec.D - 1, "concrete");
}

/** A two-lane switch-back stairwell, built once for the whole building. Each storey's flight sits in
 *  ONE of two side-by-side lanes and climbs in one z-direction; the NEXT storey's flight sits in the
 *  OTHER lane climbing back. Between them a FULL-WIDTH landing at each floor lets you walk across and
 *  turn onto the next flight — so a flight never dead-ends stacked directly under the next one (the
 *  real-world "descanso"). Also holes each slab the flight passes through, and walls the shaft sides. */
function buildStairwell(grid: VoxelGrid, x0: number, x1: number, z0: number, spec: BuildSpec): void {
  const FLOORS = spec.FLOORS, z1 = z0 + STRIDE - 1;
  const laneA1 = x0 + STAIR_LANE - 1;              // west lane [x0 .. laneA1]
  const laneB0 = x1 - STAIR_LANE + 1;             // east lane [laneB0 .. x1]
  // clear the WHOLE shaft interior first — removes the floor slabs, the ceiling beams and any wall
  // that would otherwise cross the stairs and hit your head as you climb (kept clear for the capsule).
  clearBox(grid, x0, x1, 1, FLOORS * STRIDE, z0, z1);
  fillBox(grid, x0 - 1, x0 - 1, 1, FLOORS * STRIDE, z0, z1, "brick"); // shaft side walls, full height
  fillBox(grid, x1 + 1, x1 + 1, 1, FLOORS * STRIDE, z0, z1, "brick");
  for (let s = 0; s < FLOORS; s++) {
    const base = s * STRIDE, even = s % 2 === 0;
    const lx0 = even ? x0 : laneB0, lx1 = even ? laneA1 : x1; // this flight's lane
    const up = even ? 1 : -1;
    for (let i = 1; i <= STRIDE; i++) {
      const z = up > 0 ? z0 + i - 1 : z1 - (i - 1);
      fillBox(grid, lx0, lx1, base + i - 1, base + i, z, z, "concrete");
    }
    // full-width landing at the top of this flight — extends FORWARD, past the top step (never back
    // over the climbed steps, which would become a low ceiling that blocks your head on the last steps)
    const lz0 = up > 0 ? z1 : z0 - 3;
    fillBox(grid, x0, x1, base + STRIDE, base + STRIDE, lz0, lz0 + 3, "concrete");
  }
}

const EXT_LANE = 3, EXT_OUT = EXT_LANE * 2; // two cantilever lanes so switch-back flights never stack
/** External switch-back fire-escape up the EAST facade — the SAME design as the internal stairwell:
 *  each storey's flight sits in one of two side-by-side lanes (near-wall / outer) climbing one z-way,
 *  the next storey's flight sits in the OTHER lane climbing back, and a full-width landing extends
 *  FORWARD past the top step (never back over the climbed steps, which would block your head). Board
 *  from the open street; the top landing is flush with the roof. Treads cantilever ≤ EXT_OUT off the
 *  wall (within the overhang budget → nothing floats). No rand() → deterministic. */
function buildExternalStairs(grid: VoxelGrid, ox: number, oz: number, spec: BuildSpec): void {
  const { W, FLOORS } = spec;
  const x0 = ox + W, x1 = x0 + EXT_OUT - 1;       // tread columns just outside the east wall
  const laneA1 = x0 + EXT_LANE - 1;               // near-wall lane [x0..laneA1]
  const laneB0 = x1 - EXT_LANE + 1;               // outer lane [laneB0..x1]
  const z0 = oz + 4, z1 = z0 + STRIDE - 1;
  for (let s = 0; s < FLOORS; s++) {
    const base = s * STRIDE, even = s % 2 === 0;
    const lx0 = even ? x0 : laneB0, lx1 = even ? laneA1 : x1; // this flight's lane
    const up = even ? 1 : -1;
    for (let i = 1; i <= STRIDE; i++) {
      const z = up > 0 ? z0 + i - 1 : z1 - (i - 1);
      fillBox(grid, lx0, lx1, base + i - 1, base + i, z, z, "metal");
    }
    const lz0 = up > 0 ? z1 : z0 - 3;             // full-width landing, FORWARD of the top step
    fillBox(grid, x0, x1, base + STRIDE, base + STRIDE, lz0, lz0 + 3, "metal");
  }
  // a low pad off the street: the ground flight's first tread tops out 0.5 m up (the street sits a
  // voxel below the building floor), which a 0.35 m autostep can't take — this 1-voxel pad bridges it.
  fillBox(grid, x0, x1, 0, 0, z0 - 2, z0 - 1, "metal");
  // the whole fire-escape is NON-STRUCTURAL: the building holds it up, but on its own it can't anchor
  // the building — destroy the real structure and the tower falls instead of hanging off the stairs.
  grid.markWeakBox(x0, x1, 0, FLOORS * STRIDE, z0 - 3, z1 + 3);
}

/** Sparse exterior windows: most are small glass panes, but ~1 in 5 is a big OPEN gap a drone can
 *  fly straight through. Fewer than before (stride 12) and seeded-random so every client matches. */
function placeWindows(grid: VoxelGrid, ox: number, oz: number, base: number, spec: BuildSpec): void {
  const W = spec.W, D = spec.D;
  const y0 = base + 3;
  // exactly 2 rand() per window so the PRNG stream stays identical across clients
  for (let wx = ox + 5; wx + 4 < ox + W - 4; wx += 12) {
    const big = rand() < 0.22;
    const ww = big ? 5 + Math.floor(rand() * 3) : (rand() < 0.5 ? 2 : 3); // big 5-7 · small 2-3
    const wh = big ? 4 : 3;
    for (const zw of [oz, oz + D - 1]) {
      if (big) clearBox(grid, wx, wx + ww - 1, y0, y0 + wh - 1, zw, zw);        // open → drone entry
      else fillBox(grid, wx, wx + ww - 1, y0, y0 + wh - 1, zw, zw, "glass");    // small glass pane
    }
  }
  for (let wz = oz + 5; wz + 4 < oz + D - 4; wz += 12) {
    const big = rand() < 0.22;
    const ww = big ? 5 + Math.floor(rand() * 3) : (rand() < 0.5 ? 2 : 3);
    const wh = big ? 4 : 3;
    for (const xw of [ox, ox + W - 1]) {
      if (big) clearBox(grid, xw, xw, y0, y0 + wh - 1, wz, wz + ww - 1);
      else fillBox(grid, xw, xw, y0, y0 + wh - 1, wz, wz + ww - 1, "glass");
    }
  }
}

/** Interior partition-wall positions along one axis — a subset of the column grid spaced
 *  ROOM apart, so every room wall lands on structural columns. */
function roomWalls(start: number, extent: number): number[] {
  const lines: number[] = [];
  for (let p = start + ROOM; p < start + extent - COL; p += ROOM) lines.push(p);
  return lines;
}

/** Centre of a doorway for the room span [lo, hi]: a (seeded-random) column bay so a column
 *  frames the opening on each side. `firstEdge` is the interior face of the exterior wall. */
function bayDoorCenter(lo: number, hi: number, firstEdge: number): number {
  const col0 = lo === firstEdge ? firstEdge - 1 + COL : lo;
  const nbays = Math.max(1, Math.floor((hi - col0) / COL));
  return col0 + Math.floor(rand() * nbays) * COL + (COL >> 1);
}

const KIND_NORMAL = 0, KIND_TALL = 1, KIND_VOID = 2;
interface FloorPlan { region: Int16Array; kind: Uint8Array; }

/**
 * Per-floor room layout, driven by the seeded rand() so every client builds the IDENTICAL
 * variety: which cells fuse into big open areas / long halls (a shared region id), and which
 * form double-height volumes — a TALL room on floor s that rises through a VOID on floor s+1.
 */
function planFloors(ncols: number, nrows: number, floors: number): FloorPlan[] {
  const n = ncols * nrows;
  const idx = (i: number, j: number) => j * ncols + i;
  const stair = (i: number, j: number) => i === 0 && j === 0; // stair cell — never fuse/void it
  const plans: FloorPlan[] = [];
  for (let s = 0; s < floors; s++) {
    const region = new Int16Array(n);
    for (let k = 0; k < n; k++) region[k] = k;
    plans.push({ region, kind: new Uint8Array(n) });
  }
  const fuse = (p: FloorPlan, a: number, b: number) => {
    const from = p.region[a], to = p.region[b];
    if (from === to) return;
    for (let k = 0; k < n; k++) if (p.region[k] === from) p.region[k] = to;
  };
  const norm = (p: FloorPlan, i: number, j: number) =>
    i >= 0 && i < ncols && j >= 0 && j < nrows && !stair(i, j) && p.kind[idx(i, j)] === KIND_NORMAL;

  // double-height volumes on alternating upper floors (tall below, walled-off void above)
  for (let s = 1; s + 1 < floors; s += 2)
    for (let b = 0, blocks = 1 + (rand() < 0.5 ? 1 : 0); b < blocks; b++) {
      const i0 = 1 + Math.floor(rand() * Math.max(1, ncols - 2));
      const j0 = 1 + Math.floor(rand() * Math.max(1, nrows - 2));
      let anchor = -1;
      for (let di = 0; di < 2; di++)
        for (let dj = 0; dj < 2; dj++) {
          const i = i0 + di, j = j0 + dj;
          if (i >= ncols || j >= nrows || stair(i, j) || plans[s].kind[idx(i, j)] !== KIND_NORMAL) continue;
          plans[s].kind[idx(i, j)] = KIND_TALL;
          plans[s + 1].kind[idx(i, j)] = KIND_VOID;
          if (anchor < 0) anchor = idx(i, j); else fuse(plans[s], idx(i, j), anchor); // one open tall room
        }
    }

  // big open areas + long halls over the remaining normal cells
  for (let s = 1; s < floors; s++) {
    const p = plans[s];
    if (rand() < 0.7) { // a hall spanning x
      const j = 1 + Math.floor(rand() * Math.max(1, nrows - 1));
      for (let i = 1; i < ncols; i++) if (norm(p, i - 1, j) && norm(p, i, j)) fuse(p, idx(i, j), idx(i - 1, j));
    }
    if (rand() < 0.5) { // a hall spanning z
      const i = 1 + Math.floor(rand() * Math.max(1, ncols - 1));
      for (let j = 1; j < nrows; j++) if (norm(p, i, j - 1) && norm(p, i, j)) fuse(p, idx(i, j), idx(i, j - 1));
    }
    for (let a = 0, areas = 1 + Math.floor(rand() * 2); a < areas; a++) {
      const bw = 2 + (rand() < 0.4 ? 1 : 0), bh = 2 + (rand() < 0.4 ? 1 : 0);
      const i0 = 1 + Math.floor(rand() * Math.max(1, ncols - bw));
      const j0 = 1 + Math.floor(rand() * Math.max(1, nrows - bh));
      for (let di = 0; di < bw; di++)
        for (let dj = 0; dj < bh; dj++)
          if (norm(p, i0, j0) && norm(p, i0 + di, j0 + dj)) fuse(p, idx(i0 + di, j0 + dj), idx(i0, j0));
    }
  }
  return plans;
}

/**
 * Big multi-storey building: structural column grid, an open ground-floor LOBBY, and upper
 * floors of column-aligned rooms with random big open areas, long halls and double-height
 * volumes, real switch-back stairs, varied glass windows, and a roof. Columns carry the slabs.
 */
export function buildBuilding(grid: VoxelGrid, ox = 0, oz = 0, spec: BuildSpec = BIG, wallMat: MaterialId = "brick"): void {
  const { W, D, FLOORS } = spec;
  const H = BIG.H; // storey height is constant so STRIDE is the same in every building
  const { x0: stairX0, x1: stairX1, z0: stairZ0 } = stairShaft(ox, oz);

  // Interior room grid — cell boundaries sit on the column lines (spaced ROOM apart) plus the
  // interior faces of the exterior walls. planFloors decides how cells fuse and double up.
  const xWalls = roomWalls(ox, W);
  const zWalls = roomWalls(oz, D);
  const xBounds = [ox + 1, ...xWalls, ox + W - 2];
  const zBounds = [oz + 1, ...zWalls, oz + D - 2];
  const ncols = xBounds.length - 1, nrows = zBounds.length - 1;
  const idx = (i: number, j: number) => j * ncols + i;
  const plans = planFloors(ncols, nrows, FLOORS);

  for (let s = 0; s < FLOORS; s++) {
    const base = s * STRIDE;
    const top = base + H;

    fillBox(grid, ox, ox + W - 1, base, base, oz, oz + D - 1, "concrete"); // floor slab

    // exterior walls (per-building muted tint)
    fillBox(grid, ox, ox + W - 1, base + 1, top, oz, oz, wallMat);
    fillBox(grid, ox, ox + W - 1, base + 1, top, oz + D - 1, oz + D - 1, wallMat);
    fillBox(grid, ox, ox, base + 1, top, oz, oz + D - 1, wallMat);
    fillBox(grid, ox + W - 1, ox + W - 1, base + 1, top, oz, oz + D - 1, wallMat);

    if (s > 0) {
      const p = plans[s];

      // open each double-height VOID: drop this floor's slab (and the beams just under it) over
      // the cell interior so the TALL room below rises two storeys, keeping a 1-voxel lip at the
      // cell edges so the perimeter railings stay supported.
      for (let j = 0; j < nrows; j++)
        for (let i = 0; i < ncols; i++)
          if (p.kind[idx(i, j)] === KIND_VOID)
            clearBox(grid, xBounds[i] + 1, xBounds[i + 1] - 1, base - 1, base, zBounds[j] + 1, zBounds[j + 1] - 1);

      // partition walls between cells: a doorway between two different rooms, a solid railing
      // where a room meets a double-height void, and nothing inside a fused area/hall.
      for (let j = 0; j < nrows; j++)
        for (let i = 0; i + 1 < ncols; i++) {
          const a = idx(i, j), b = idx(i + 1, j);
          const va = p.kind[a] === KIND_VOID, vb = p.kind[b] === KIND_VOID;
          if (va && vb) continue;
          const rail = va !== vb;
          if (!rail && p.region[a] === p.region[b]) continue;
          const wx = xBounds[i + 1];
          fillBox(grid, wx, wx, base + 1, top, zBounds[j], zBounds[j + 1], "brick");
          if (!rail) {
            const c = bayDoorCenter(zBounds[j], zBounds[j + 1], oz + 1);
            clearBox(grid, wx, wx, base + 1, base + DOOR_TOP, c - 1, c + 1);
          }
        }
      for (let j = 0; j + 1 < nrows; j++)
        for (let i = 0; i < ncols; i++) {
          const a = idx(i, j), b = idx(i, j + 1);
          const va = p.kind[a] === KIND_VOID, vb = p.kind[b] === KIND_VOID;
          if (va && vb) continue;
          const rail = va !== vb;
          if (!rail && p.region[a] === p.region[b]) continue;
          const wz = zBounds[j + 1];
          fillBox(grid, xBounds[i], xBounds[i + 1], base + 1, top, wz, wz, "brick");
          if (!rail) {
            const c = bayDoorCenter(xBounds[i], xBounds[i + 1], ox + 1);
            clearBox(grid, c - 1, c + 1, base + 1, base + DOOR_TOP, wz, wz);
          }
        }
    }

    buildBeams(grid, ox, oz, top, spec);
    placeWindows(grid, ox, oz, base, spec);
    if (s === 0) placeGasTank(grid, ox + W - 6, base + 1, oz + D - 6);
  }

  // Columns carry every slab — built last so they stay solid concrete where the brick
  // partition walls cross them (and so no column ever lands inside a doorway).
  buildColumns(grid, ox, oz, spec);

  // 2–3 ground-floor entrances on distinct exterior walls (seeded). Positions keep clear of the
  // stair shaft in the (ox,oz) corner so no entrance opens into the stairwell.
  const entranceAt = (wall: number): void => {
    const px = ox + 8 + Math.floor(rand() * Math.max(1, W - 16));      // safe span of the X walls
    const pzFar = oz + (D >> 1) + Math.floor(rand() * Math.max(1, Math.floor(D * 0.35))); // left wall: past the shaft
    const pz = oz + 6 + Math.floor(rand() * Math.max(1, D - 14));
    if (wall === 0) clearBox(grid, px, px + 3, 1, DOOR_TOP, oz, oz);                 // front
    else if (wall === 1) clearBox(grid, px, px + 3, 1, DOOR_TOP, oz + D - 1, oz + D - 1); // back
    else if (wall === 2) clearBox(grid, ox, ox, 1, DOOR_TOP, pzFar, pzFar + 3);      // left (shaft side)
    else clearBox(grid, ox + W - 1, ox + W - 1, 1, DOOR_TOP, pz, pz + 3);            // right
  };
  const walls = [0, 1, 2, 3];
  for (let i = walls.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [walls[i], walls[j]] = [walls[j], walls[i]]; }
  const nEnt = 2 + (rand() < 0.5 ? 1 : 0);
  for (let e = 0; e < nEnt; e++) entranceAt(walls[e]);

  const roofY = FLOORS * STRIDE;
  fillBox(grid, ox, ox + W - 1, roofY, roofY, oz, oz + D - 1, "concrete");

  // the internal stairwell holes every slab it passes (including the roof) and lands flush on top
  buildStairwell(grid, stairX0, stairX1, stairZ0, spec);
  buildExternalStairs(grid, ox, oz, spec); // fire-escape up the east wall to the roof
  decorateBuilding(grid, ox, oz, spec); // subtle exterior character (parapet, cornices, sign, balconies)
  furnishBuilding(grid, ox, oz, spec);  // light interior dressing (crates/desks + upper-floor gas-tank hazards)
}

/** Light interior dressing, seeded → identical per client: a few crates/desks in the ground-floor lobby and
 *  extra gas-tank hazards on some upper floors. Every piece is placed ONLY on a cell that is empty AND has a
 *  solid floor directly below (so it never overwrites a column/wall/slab and never floats over a double-height
 *  void), and is markSettled (non-structural) → it can't perturb the collapse solver or the structural tests. */
function furnishBuilding(grid: VoxelGrid, ox: number, oz: number, spec: BuildSpec): void {
  const { W, D, FLOORS } = spec;
  const canPlace = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (!grid.has(x, y0 - 1, z)) return false; // solid floor below
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (grid.has(x, y, z)) return false; // clear
    return true;
  };
  // A furnishing is NON-STRUCTURAL — markWeakBox drops it from the collapse/pancake mass solve (so a gas tank
  // on an upper slab can't be mistaken for load-bearing section and false-pancake). It is deliberately NOT
  // markSettled: settling would ground-ANCHOR the cell permanently, so a tank on an upper floor would float
  // when the storeys below are destroyed. Left un-anchored, it rests on its slab (canPlace guarantees one
  // directly below → the cell bears via that slab) while intact, and falls with the building when gutted.
  const prop = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MaterialId): void => {
    fillBox(grid, x0, x1, y0, y1, z0, z1, mat);
    grid.markWeakBox(x0, x1, y0, y1, z0, z1);
  };
  const nProps = 1 + Math.floor(rand() * 3); // crates + low desks across the ground lobby (light — every building pays)
  for (let i = 0; i < nProps; i++) {
    const fx = ox + 10 + Math.floor(rand() * Math.max(1, W - 22));
    const fz = oz + 10 + Math.floor(rand() * Math.max(1, D - 22));
    if (rand() < 0.5) { if (canPlace(fx, fx + 1, 1, 2, fz, fz + 1)) prop(fx, fx + 1, 1, 2, fz, fz + 1, "wood"); }      // crate
    else { if (canPlace(fx, fx + 2, 1, 1, fz, fz + 1)) prop(fx, fx + 2, 1, 1, fz, fz + 1, "wood"); }                  // low desk
  }
  for (let s = 1; s < FLOORS; s++) // extra gas-tank hazards on some upper floors (something to shoot inside)
    if (rand() < 0.3) {
      const gx = ox + 6 + Math.floor(rand() * Math.max(1, W - 14)), gz = oz + 6 + Math.floor(rand() * Math.max(1, D - 14)), gy = s * STRIDE + 1;
      if (canPlace(gx, gx + 1, gy, gy + 4, gz, gz + 1)) prop(gx, gx + 1, gy, gy + 4, gz, gz + 1, "gastank");
    }
}

const SIGN_MATS: MaterialId[] = ["glass", "metal", "wall_navy", "wall_clay"];

/** Subtle per-building exterior character, seeded → identical on every client: a roof parapet (3 sides,
 *  the east edge left clear for the fire-escape landing), thin cornice ledges at each floor line, a
 *  facade sign, and a few balconies. Every piece is a ≤2-voxel cantilever bonded to a wall, so it stays
 *  supported at the collapse overhang budget (no false floaters). */
function decorateBuilding(grid: VoxelGrid, ox: number, oz: number, spec: BuildSpec): void {
  const { W, D, FLOORS } = spec;
  const roofY = FLOORS * STRIDE, x1 = ox + W - 1, z1 = oz + D - 1;
  const trim: MaterialId = "concrete";

  // roof parapet on three sides (skip the EAST wall — the external stairs land on the roof there)
  fillBox(grid, ox, x1, roofY + 1, roofY + 2, oz, oz, trim);
  fillBox(grid, ox, x1, roofY + 1, roofY + 2, z1, z1, trim);
  fillBox(grid, ox, ox, roofY + 1, roofY + 2, oz, z1, trim);

  // thin cornice ledges protruding 1 voxel at each floor line (front + back) → horizontal facade lines
  for (let s = 1; s < FLOORS; s++) {
    const y = s * STRIDE;
    fillBox(grid, ox, x1, y, y, oz - 1, oz - 1, trim);
    fillBox(grid, ox, x1, y, y, z1 + 1, z1 + 1, trim);
  }

  // a facade sign above the ground floor (seeded position + colour) — the "rótulo"
  const sMat = SIGN_MATS[Math.floor(rand() * SIGN_MATS.length)];
  const sw = 4 + Math.floor(rand() * 4);
  const sx = ox + 3 + Math.floor(rand() * Math.max(1, W - sw - 6));
  const sy = STRIDE - 4;
  fillBox(grid, sx, sx + sw, sy, sy + 2, oz - 1, oz - 1, sMat);

  // balconies on some upper floors (front wall): a 2-voxel ledge + a low railing
  for (let s = 2; s < FLOORS; s++) {
    if (rand() < 0.45) continue;
    const bw = 4 + Math.floor(rand() * 3);
    const bx = ox + 3 + Math.floor(rand() * Math.max(1, W - bw - 6));
    const by = s * STRIDE + 1;
    fillBox(grid, bx, bx + bw, by, by, oz - 2, oz - 1, trim);          // balcony floor (out 2)
    fillBox(grid, bx, bx + bw, by + 1, by + 2, oz - 2, oz - 2, trim);  // front railing
    fillBox(grid, bx, bx, by + 1, by + 2, oz - 2, oz - 1, trim);       // side rails
    fillBox(grid, bx + bw, bx + bw, by + 1, by + 2, oz - 2, oz - 1, trim);
  }
}

export interface Placed { ox: number; oz: number; W: number; D: number; FLOORS: number }
// A mini-town: a 9×11 plot grid (99 plots) with a central 3×3 plaza carved out → 90 buildings. Plot size
// is fixed (its own source of truth, not derived from BIG) so buildings keep the exact geometry that
// passes the collapse solver — tripling the count is pure footprint growth, no false floaters.
const STREET = 14;
const PLOT_W = 57, PLOT_D = 54;

// Map-size presets. The largest ("large") IS the current world; smaller presets shrink the plot grid for
// fewer players. The size travels with the room (synced in the `begin` message), never a local-only choice.
export type MapSize = "small" | "medium" | "large";
export const MAP_SIZES: Record<MapSize, { label: string; plotsX: number; plotsZ: number; players: number }> = {
  small:  { label: "Pequeño", plotsX: 5, plotsZ: 5,  players: 6 },
  medium: { label: "Mediano", plotsX: 7, plotsZ: 8,  players: 16 },
  large:  { label: "Grande",  plotsX: 9, plotsZ: 11, players: 50 }, // = the current map
};

// Live map dimensions — mutable so setMapSize() can rescale the world. Initialised to the LARGE (current)
// values so a module that never calls setMapSize (unit tests) builds the exact same world as before.
let PLOTS_X = 9, PLOTS_Z = 11;
// central plaza (3×3 centred block) + boulevard cross + suburb rows — only on the bigger maps (CITY_FEATURES);
// the small arena drops them for a dense tower field. Plaza/avenue plot indices derive CENTRED from the grid,
// so at 9×11 they reproduce the historical 3-5/4-6 & 4/5 exactly (byte-identical default).
let PLAZA_PX0 = 3, PLAZA_PX1 = 5, PLAZA_PZ0 = 4, PLAZA_PZ1 = 6;
let AVENUE_PX = 4, AVENUE_PZ = 5;
let CITY_FEATURES = true; // plaza / avenue / suburbs present (large + medium); false on the small arena
const AVENUE_HALF = 17;   // half-width of the boulevard asphalt in voxels (~4.25 m/side); size-independent

const inPlaza = (px: number, pz: number): boolean =>
  CITY_FEATURES && px >= PLAZA_PX0 && px <= PLAZA_PX1 && pz >= PLAZA_PZ0 && pz <= PLAZA_PZ1;
const onAvenuePlot = (px: number, pz: number): boolean => CITY_FEATURES && (px === AVENUE_PX || pz === AVENUE_PZ);
const isResidential = (pz: number): boolean => CITY_FEATURES && (pz === 0 || pz === PLOTS_Z - 1);

/** City ground extent in VOXELS (the plot grid buildDefaultScene fills). Mutated by setMapSize. */
export const CITY_VOX = { x1: PLOTS_X * PLOT_W, z1: PLOTS_Z * PLOT_D };
// Voxel-space centre lines of the two boulevards (used by groundClass painting + the median dressing).
let AVENUE_VX = (AVENUE_PX + 0.5) * PLOT_W, AVENUE_VZ = (AVENUE_PZ + 0.5) * PLOT_D;

/** Classifies a voxel-space XZ column under the city so the ground can be painted as a real city floor:
 *  'street' (a plot-boundary gap → asphalt), 'plot' (under/around a building → concrete apron), or
 *  'outside' (beyond the footprint → grass). Pure & deterministic → unit-testable, visual only. */
export function groundClass(vx: number, vz: number): "street" | "plot" | "outside" {
  const m = 6; // pavement extends a little past the outer plots
  if (vx < -m || vz < -m || vx > CITY_VOX.x1 + m || vz > CITY_VOX.z1 + m) return "outside";
  // the grand-boulevard cross: a wide asphalt corridor with a thin concrete median down each centre line
  // (only on the bigger maps — the small arena has no avenue, so its centre plots hold towers, not asphalt)
  if (CITY_FEATURES && (Math.abs(vx - AVENUE_VX) <= AVENUE_HALF || Math.abs(vz - AVENUE_VZ) <= AVENUE_HALF))
    return (Math.abs(vx - AVENUE_VX) <= 2 || Math.abs(vz - AVENUE_VZ) <= 2) ? "plot" : "street";
  const nearBoundary = (v: number, period: number) => {
    const r = ((v % period) + period) % period;
    return r < STREET / 2 || r > period - STREET / 2; // within half a street-width of a plot boundary
  };
  return nearBoundary(vx, PLOT_W) || nearBoundary(vz, PLOT_D) ? "street" : "plot";
}

/** An ammo-crate pickup site (voxel-space XZ column; the crate rests on the ground plane). */
export interface AmmoSite { vx: number; vz: number }

// Ammo crates for the soldiers, scattered along the city's vertical avenues on a regular grid so they
// blanket the whole map. Seeded from the world seed via its OWN Rng stream (NOT the city rand() stream),
// so it's identical on every client WITHOUT perturbing building/vehicle/objective placement. Every point
// sits on a street line (a plot-column boundary → guaranteed clear of the buildings by groundClass).
const AMMO_SEED_TAG = 0x0a33c0;
export function ammoBoxSites(worldSeed: number): AmmoSite[] {
  const rng = new Rng(mix32(worldSeed >>> 0, AMMO_SEED_TAG));
  const sites: AmmoSite[] = [];
  for (let px = 1; px < PLOTS_X; px++) {          // each interior vertical avenue (a plot-column gap)
    const xl = px * PLOT_W;
    for (let pz = 0; pz < PLOTS_Z; pz++) {         // one crate per block down the avenue → a full-map grid
      const vx = Math.round(xl + rng.centered(8));                       // ±4 across the avenue → stays street
      const vz = Math.round((pz + 0.5) * PLOT_D + rng.centered(PLOT_D * 0.4));
      if (groundClass(vx, vz) === "street") sites.push({ vx, vz });      // defensive: only real street spots
    }
  }
  return sites;
}

// Medkit crates (bandage resupply): fewer than ammo, on the HORIZONTAL streets, every other block, from their
// OWN seeded stream so they're identical on every client and don't sit exactly on the ammo grid.
const MEDKIT_SEED_TAG = 0x3ed1c7;
export function medkitSites(worldSeed: number): AmmoSite[] {
  const rng = new Rng(mix32(worldSeed >>> 0, MEDKIT_SEED_TAG));
  const sites: AmmoSite[] = [];
  for (let pz = 1; pz < PLOTS_Z; pz++) {            // each interior horizontal street
    const zl = pz * PLOT_D;
    for (let px = 0; px < PLOTS_X; px += 2) {        // every OTHER block → sparser than the ammo grid
      const vx = Math.round((px + 0.5) * PLOT_W + rng.centered(PLOT_W * 0.4));
      const vz = Math.round(zl + rng.centered(8));
      if (groundClass(vx, vz) === "street") sites.push({ vx, vz });
    }
  }
  return sites;
}
/** Muted facade palette — brick plus the sombre wall tints; one is picked per building. */
const WALL_MATS: MaterialId[] = ["brick", "wall_slate", "wall_moss", "wall_clay", "wall_navy"];
let _placed: Placed[] = [];
/** The buildings placed by the last buildDefaultScene — used to site the DvH bases. */
export function placedBuildings(): readonly Placed[] { return _placed; }

/** A central town plaza: a stepped concrete monument + metal spire, benches, and a ring of trees and
 *  lampposts. All markSettled (non-structural) so the decor never trips the collapse solver. */
function buildPlaza(grid: VoxelGrid): void {
  const cx = Math.round(((PLAZA_PX0 + PLAZA_PX1 + 1) / 2) * PLOT_W); // plaza centre in voxels
  const cz = Math.round(((PLAZA_PZ0 + PLAZA_PZ1 + 1) / 2) * PLOT_D);
  fillBox(grid, cx - 4, cx + 4, 0, 1, cz - 4, cz + 4, "concrete");   // stepped base
  fillBox(grid, cx - 3, cx + 3, 2, 3, cz - 3, cz + 3, "concrete");
  fillBox(grid, cx - 1, cx + 1, 4, 5, cz - 1, cz + 1, "concrete");
  fillBox(grid, cx, cx, 6, 11, cz, cz, "metal");                     // spire
  markSettledBox(grid, cx - 4, cx + 4, 0, 11, cz - 4, cz + 4);
  for (const [bx, bz] of [[cx - 10, cz], [cx + 10, cz], [cx, cz - 10], [cx, cz + 10]] as const) {
    fillBox(grid, bx - 1, bx + 1, 0, 0, bz - 1, bz + 1, "wood");     // benches
    markSettledBox(grid, bx - 1, bx + 1, 0, 0, bz - 1, bz + 1);
  }
  for (let a = 0; a < 8; a++) {                                       // ring of trees + lampposts
    const ang = (a / 8) * Math.PI * 2;
    const tx = Math.round(cx + Math.cos(ang) * 18), tz = Math.round(cz + Math.sin(ang) * 18);
    if (a % 2 === 0) buildTree(grid, tx, tz); else buildLamppost(grid, tx, tz);
  }
}

// Static forest wall around the whole city: an INDESTRUCTIBLE treeline (plus a continuous low hedge that
// actually blocks passage at ground level) sealing every edge, with ONE gate at the south end of the N-S
// boulevard — itself plugged by indestructible trucks. Nothing here can be shot, blown up or knocked down.
const FOREST_MARGIN = 48, FOREST_DEPTH = 30, FOREST_SPACING = 10; // margin = hedge inset (a wide ~12 m flat field between the city and the boundary)
const TREE_GAP = 24;  // clearing (voxels, ~6 m) between the hedge and the treeline → the whole boundary (hedge + trees) sits ~12-18 m off the city
const HEDGE_TOP = 7;  // hedge height (voxels, ~1.75 m): a view-blocking green wall on every edge — hides the clearing + the fogged void behind it
const GATE_HALF = AVENUE_HALF + 3;

/** Forest-ring geometry (voxels), the single source of truth shared by the builder AND the tests: the hedge
 *  sits `hedgeInset` outside the city, the treeline starts `treeGap` further out and is `depth` thick. */
export const FOREST_RING = { hedgeInset: FOREST_MARGIN, treeGap: TREE_GAP, depth: FOREST_DEPTH, hedgeTop: HEDGE_TOP };

// World-space rectangle the human is confined to: the forest ring's INNER faces (where the hedge sits). The
// ring seals the map visually + on the ground, but a soldier could climb a perimeter building and jump the
// short (1 m) treeline — so the Walker also hard-clamps to this box, sealing the edge at ANY height. Byte-
// identical everywhere (derived from the same seeded constants); render/controller-only → no sim divergence.
export const PLAY_BOUNDS = {
  minX: (-FOREST_MARGIN + 1) * VOXEL,
  maxX: (CITY_VOX.x1 + FOREST_MARGIN) * VOXEL,
  minZ: (-FOREST_MARGIN + 1) * VOXEL,
  maxZ: (CITY_VOX.z1 + FOREST_MARGIN) * VOXEL,
};

/** Rescale the world to a size preset. Call BEFORE buildDefaultScene (like setWorldSeed) so the whole room
 *  agrees on the extent. Mutates the exported CITY_VOX / PLAY_BOUNDS IN PLACE (never reassigns) so existing
 *  imports keep pointing at the live objects. "large" reproduces the historical constants exactly. */
export function setMapSize(size: MapSize): void {
  const p = MAP_SIZES[size] ?? MAP_SIZES.large;
  PLOTS_X = p.plotsX; PLOTS_Z = p.plotsZ;
  CITY_FEATURES = p.plotsX >= 7 && p.plotsZ >= 7;                  // plaza/avenue/suburbs only on the bigger maps
  const cx = Math.floor(PLOTS_X / 2), cz = Math.floor(PLOTS_Z / 2); // centred plaza/avenue → 9×11 gives 3-5/4-6 & 4/5
  PLAZA_PX0 = cx - 1; PLAZA_PX1 = cx + 1; PLAZA_PZ0 = cz - 1; PLAZA_PZ1 = cz + 1;
  AVENUE_PX = cx; AVENUE_PZ = cz;
  AVENUE_VX = (AVENUE_PX + 0.5) * PLOT_W; AVENUE_VZ = (AVENUE_PZ + 0.5) * PLOT_D;
  CITY_VOX.x1 = PLOTS_X * PLOT_W; CITY_VOX.z1 = PLOTS_Z * PLOT_D;
  PLAY_BOUNDS.maxX = (CITY_VOX.x1 + FOREST_MARGIN) * VOXEL;
  PLAY_BOUNDS.maxZ = (CITY_VOX.z1 + FOREST_MARGIN) * VOXEL;
}

/** Builds the forest wall + the sealed gate. All voxels are weak+settled (non-structural, anchored → never
 *  enter the collapse solver) and INDESTRUCTIBLE. Deterministic (position-hashed, no rand()) so it's byte-
 *  identical on every client and never perturbs the city's rand() stream. */
function buildForestRing(grid: VoxelGrid): void {
  const ix0 = -FOREST_MARGIN, ix1 = CITY_VOX.x1 + FOREST_MARGIN, iz0 = -FOREST_MARGIN, iz1 = CITY_VOX.z1 + FOREST_MARGIN;
  // the treeline is SET BACK from the hedge by TREE_GAP (a clearing), then FOREST_DEPTH thick beyond that —
  // so the canopies never crowd the perimeter buildings, while the hedge still seals the edge right at the city.
  const tx0 = ix0 - TREE_GAP, tx1 = ix1 + TREE_GAP, tz0 = iz0 - TREE_GAP, tz1 = iz1 + TREE_GAP;
  const ox0 = tx0 - FOREST_DEPTH, ox1 = tx1 + FOREST_DEPTH, oz0 = tz0 - FOREST_DEPTH, oz1 = tz1 + FOREST_DEPTH;
  const gateX = Math.round(AVENUE_VX);
  const atGate = (vx: number, vz: number): boolean => Math.abs(vx - gateX) <= GATE_HALF && vz < iz0; // the south gate corridor
  // scattered indestructible trees filling the ring band (skip the city + its clearing, and the gate mouth)
  for (let vx = ox0; vx <= ox1; vx += FOREST_SPACING)
    for (let vz = oz0; vz <= oz1; vz += FOREST_SPACING) {
      if (vx > tx0 && vx < tx1 && vz > tz0 && vz < tz1) continue; // inside the city/clearing → no forest
      if (atGate(vx, vz)) continue;
      buildTree(grid, vx + (mix32(vx, vz) % 3) - 1, vz + (mix32(vz, vx, 7) % 3) - 1, undefined, true);
    }
  // a continuous hedge along the inner edge — the real ground-level barrier AND a view-blocking green wall
  // (HEDGE_TOP ≈ 1.75 m, above eye level) that hides the clearing + the fogged void so every edge reads solid.
  const hedge = (x0: number, x1: number, z0: number, z1: number): void => {
    if (x1 < x0 || z1 < z0) return;
    fillBox(grid, x0, x1, 0, HEDGE_TOP, z0, z1, "leaves");
    grid.markWeakBox(x0, x1, 0, HEDGE_TOP, z0, z1);
    markSettledBox(grid, x0, x1, 0, HEDGE_TOP, z0, z1);
    grid.markIndestructibleBox(x0, x1, 0, HEDGE_TOP, z0, z1);
  };
  hedge(ix0 - 1, ix1 + 1, iz1, iz1 + 1);                          // north edge
  hedge(ix0 - 1, ix0, iz0 - 1, iz1 + 1);                          // west edge
  hedge(ix1, ix1 + 1, iz0 - 1, iz1 + 1);                          // east edge
  hedge(ix0 - 1, gateX - GATE_HALF - 1, iz0 - 1, iz0);            // south edge, left of the gate
  hedge(gateX + GATE_HALF + 1, ix1 + 1, iz0 - 1, iz0);           // south edge, right of the gate
  // SEAL the gate: a row of indestructible trucks straddling the boulevard exit
  for (let i = -1; i <= 1; i++) {
    const tx = gateX + i * 15 - 9, tz = iz0 - 8;
    buildTruck(grid, tx, tz, "metal");
    grid.markIndestructibleBox(tx - 1, tx + 20, 0, 10, tz - 1, tz + 9);
  }
}

/** A suburban plot: a seeded cluster of 2-4 small brick houses inset from the plot edges (so the streets
 *  around it stay clear) plus a yard tree. Houses are ordinary destructible structures, grounded from y=0. */
function buildHouseCluster(grid: VoxelGrid, px: number, pz: number): void {
  const bx = px * PLOT_W, bz = pz * PLOT_D;
  const spots = [[8, 6], [34, 6], [8, 32], [34, 32]] as const; // a 2×2 layout, each inset ≥6 from the plot edges
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const n = 2 + Math.floor(rand() * 3); // 2-4 houses
  for (let k = 0; k < n; k++) { const [dx, dz] = spots[order[k]]; buildHouse(grid, bx + dx, bz + dz); }
  if (rand() < 0.85) buildTree(grid, bx + 26, bz + 26); // a yard tree in the central gap
}

/** A mini-town: a tall core ringed by suburbs on a 9×11 plot grid with a central plaza, a boulevard cross,
 *  some "equal" (a fixed uniform size), some tall landmarks, the rest randomised — plus destructible
 *  street dressing (trees, lampposts, bins, litter) and parked vehicles. Seeded rand() → every client
 *  generates the IDENTICAL town (destruction sync). */
export function buildDefaultScene(grid: VoxelGrid): void {
  grid.clear();
  _placed = [];
  for (let px = 0; px < PLOTS_X; px++)
    for (let pz = 0; pz < PLOTS_Z; pz++) {
      if (inPlaza(px, pz) || onAvenuePlot(px, pz)) continue;                                    // plaza + boulevard corridors carry no building
      if (isResidential(pz)) { buildHouseCluster(grid, px, pz); continue; }                      // suburb ring: houses, not a tower
      const i = px * PLOTS_Z + pz;
      let W: number, D: number, FLOORS: number;
      const roll = rand();
      if (i % 7 === 0) {                                                                        // rare taller landmark
        W = PLOT_W - STREET; D = PLOT_D - STREET; FLOORS = 5 + Math.floor(rand() * 3);          // 5-7 storeys
      } else if (roll < 0.3) {                                                                  // a mid-rise: bigger footprint, 3-4 storeys
        W = Math.max(34, Math.round((0.7 + rand() * 0.25) * (PLOT_W - STREET)));
        D = Math.max(34, Math.round((0.7 + rand() * 0.25) * (PLOT_D - STREET)));
        FLOORS = 3 + Math.floor(rand() * 2);
      } else {                                                                                  // the majority: small & low
        W = Math.max(34, Math.round((0.55 + rand() * 0.4) * (PLOT_W - STREET)));
        D = Math.max(34, Math.round((0.55 + rand() * 0.4) * (PLOT_D - STREET)));
        FLOORS = 2 + Math.floor(rand() * 2);
      }
      const wallMat = WALL_MATS[Math.floor(rand() * WALL_MATS.length)];
      const ox = px * PLOT_W + Math.floor((PLOT_W - W) / 2);
      const oz = pz * PLOT_D + Math.floor((PLOT_D - D) / 2);
      buildBuilding(grid, ox, oz, { W, D, FLOORS }, wallMat);
      _placed.push({ ox, oz, W, D, FLOORS });
    }
  if (CITY_FEATURES) buildPlaza(grid); // central monument/plaza — only on the bigger maps (small = tower arena)
  // parked vehicles along the horizontal streets (seeded → identical on every client), varied type + paint
  const PAINTS: MaterialId[] = ["car_red", "car_blue", "car_teal", "metal"];
  const park = (ox: number, oz: number): void => {
    const paint = PAINTS[Math.floor(rand() * PAINTS.length)];
    const t = rand();
    if (t < 0.45) buildCar(grid, ox, oz, paint);
    else if (t < 0.75) buildVan(grid, ox, oz, paint);
    else buildTruck(grid, ox, oz, paint);
  };
  buildCar(grid, -16, 8, "car_red"); // the original parked car, west of the town
  for (let pz = 1; pz < PLOTS_Z; pz++) {
    const z = pz * PLOT_D - 4;                       // in the horizontal street gap (clear of buildings)
    const n = 2 + Math.floor(rand() * 3);            // 2-4 vehicles per street (denser than before)
    for (let k = 0; k < n; k++) park(6 + Math.floor(rand() * (PLOTS_X * PLOT_W - 30)), z);
  }
  // destructible street furniture down the vertical avenues (plot-column gaps → clear of buildings). All
  // markSettled inside their builders, so they never trip the collapse solver. Seeded → identical per client.
  for (let px = 1; px < PLOTS_X; px++) {
    const xl = px * PLOT_W;
    for (let pz = 0; pz < PLOTS_Z; pz++) {
      if (inPlaza(px, pz) || inPlaza(px - 1, pz)) continue;         // leave the plaza frontage open
      const zc = Math.round((pz + 0.5) * PLOT_D) + (Math.floor(rand() * 11) - 5);
      const sideA = rand() < 0.5 ? -3 : 3, sideB = -sideA;
      if (rand() < 0.75) buildTree(grid, xl + sideA, zc);
      if (rand() < 0.55) buildLamppost(grid, xl + sideB, zc + 8);
      if (rand() < 0.4) buildTrashCan(grid, xl + sideB, zc - 6);
      if (rand() < 0.4) buildLitter(grid, xl + sideA, zc + 3);
    }
  }
  // Grand-boulevard median: alternating trees + lampposts down each centre line, plus lane traffic. Skips a
  // band around the plaza/intersection so the crossing stays open. Seeded rand() → identical per client.
  // Median is CENTRAL (always on-screen), so it's kept light: sparse (every 28 vox), mostly cheap lampposts
  // over dense tree canopies, and only occasional lane traffic — this is a hot spot for draws/fill.
  // Grand-boulevard median decor — only on the bigger maps (the small arena's centre is towers, not an avenue).
  if (CITY_FEATURES) {
    const avX = Math.round(AVENUE_VX), avZ = Math.round(AVENUE_VZ);
    for (let vz = 8; vz < CITY_VOX.z1 - 8; vz += 28) {
      if (Math.abs(vz - avZ) <= AVENUE_HALF + 6) continue;              // keep the crossing/plaza open
      if (rand() < 0.35) buildTree(grid, avX, vz); else buildLamppost(grid, avX - 1, vz);
      if (rand() < 0.3) park(avX - 13, vz - 3);                        // occasional vehicle in the west lane
    }
    for (let vx = 8; vx < CITY_VOX.x1 - 8; vx += 28) {
      if (Math.abs(vx - avX) <= AVENUE_HALF + 6) continue;
      if (rand() < 0.35) buildTree(grid, vx, avZ); else buildLamppost(grid, vx, avZ - 1);
      if (rand() < 0.3) park(vx - 3, avZ - 13);                        // occasional vehicle in the north lane
    }
  }
  buildForestRing(grid); // the indestructible treeline that walls the whole map in (one sealed gate)
}

// Drones-vs-Humans bases (destructible objectives). Each carries the voxel bounds + its built voxel
// count (for an HP % as it's chewed away). Each team defends TWO bases; a team wins by razing both.
export interface ObjSite { team: "drone" | "human"; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; initial: number }
/** Populated by buildObjectives from the placed buildings → dynamic but deterministic (seeded).
 *  Four sites: 2 drone rooftops + 2 human bunkers, in four distinct buildings. */
export let OBJECTIVE_SITES: ObjSite[] = [];

// Count only the base's OWN metal — so debris that settles into the bounds after a collapse can't
// inflate the HP and stall a legitimate win.
function countMetal(matAt: (x: number, y: number, z: number) => MaterialId | undefined, s: ObjSite): number {
  let n = 0;
  for (let x = s.x0; x <= s.x1; x++) for (let y = s.y0; y <= s.y1; y++) for (let z = s.z0; z <= s.z1; z++) if (matAt(x, y, z) === "metal") n++;
  return n;
}

/** A metal bunker in a building's lobby (drones must fly in to destroy it). */
function humanBase(grid: VoxelGrid, bld: Placed): ObjSite {
  const hx = bld.ox + (bld.W >> 1), hz = bld.oz + (bld.D >> 1);
  const s: ObjSite = { team: "human", x0: hx - 2, x1: hx + 2, y0: 1, y1: 5, z0: hz - 2, z1: hz + 2, initial: 0 };
  fillBox(grid, s.x0, s.x1, s.y0, s.y1, s.z0, s.z1, "metal");
  s.initial = countMetal((x, y, z) => grid.get(x, y, z), s);
  return s;
}

/** A metal landing pad + antenna on a rooftop (humans climb the stairs to destroy it). */
function droneBase(grid: VoxelGrid, bld: Placed): ObjSite {
  const dx = bld.ox + (bld.W >> 1), dz = bld.oz + (bld.D >> 1), ry = bld.FLOORS * STRIDE;
  const s: ObjSite = { team: "drone", x0: dx - 3, x1: dx + 3, y0: ry + 1, y1: ry + 4, z0: dz - 3, z1: dz + 3, initial: 0 };
  fillBox(grid, s.x0, s.x1, ry + 1, ry + 1, s.z0, s.z1, "metal"); // landing pad
  fillBox(grid, dx, dx, ry + 1, ry + 4, dz, dz, "metal");         // antenna beacon
  s.initial = countMetal((x, y, z) => grid.get(x, y, z), s);
  return s;
}

/** Places TWO bases per team, each in a DISTINCT building (seeded → identical on every client). */
export function buildObjectives(grid: VoxelGrid): void {
  const b = _placed;
  OBJECTIVE_SITES = [];
  if (b.length < 4) return;
  const picks: number[] = [];
  const used = new Set<number>();
  while (picks.length < 4) { const i = Math.floor(rand() * b.length); if (!used.has(i)) { used.add(i); picks.push(i); } }
  OBJECTIVE_SITES = [
    droneBase(grid, b[picks[0]]), droneBase(grid, b[picks[1]]),
    humanBase(grid, b[picks[2]]), humanBase(grid, b[picks[3]]),
  ];
}

/** An objective is alive while any voxel inside its bounds survives. `has` is grid.has (or a mock). */
export function objectiveAlive(site: ObjSite, has: (x: number, y: number, z: number) => boolean): boolean {
  for (let x = site.x0; x <= site.x1; x++)
    for (let y = site.y0; y <= site.y1; y++)
      for (let z = site.z0; z <= site.z1; z++)
        if (has(x, y, z)) return true;
  return false;
}

/** Fraction of a base's METAL still standing (1 = pristine, 0 = razed) — drives the HUD HP bar.
 *  `matAt` is grid.get (returns the material, or undefined) — counting metal ignores stray debris. */
export function objectiveHp(site: ObjSite, matAt: (x: number, y: number, z: number) => MaterialId | undefined): number {
  return site.initial > 0 ? countMetal(matAt, site) / site.initial : 0;
}

/** A base counts as DESTROYED for the win once ~75% of its metal is gone (no need to clear every voxel). */
export function objectiveDestroyed(site: ObjSite, matAt: (x: number, y: number, z: number) => MaterialId | undefined): boolean {
  return objectiveHp(site, matAt) < 0.25;
}
