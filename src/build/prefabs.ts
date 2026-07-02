import type { MaterialId } from "../world/materials";
import type { VoxelGrid } from "../world/voxelGrid";

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

  // door (front wall, z = oz)
  clearBox(grid, ox + 6, ox + 9, 1, 6, oz, oz);
  // glass windows on the side walls
  fillBox(grid, ox, ox, 5, 8, oz + 3, oz + 5, "glass");
  fillBox(grid, ox, ox, 5, 8, oz + 8, oz + 10, "glass");
  fillBox(grid, ox + W - 1, ox + W - 1, 5, 8, oz + 3, oz + 5, "glass");
  fillBox(grid, ox + W - 1, ox + W - 1, 5, 8, oz + 8, oz + 10, "glass");
  // glass window above the door + back window
  fillBox(grid, ox + 6, ox + 9, 8, 10, oz, oz, "glass");
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

/** Static destructible car: metal body + glass cabin + dark wheels. */
export function buildCar(grid: VoxelGrid, ox = 2, oz = -9): void {
  // lower body
  fillBox(grid, ox, ox + 13, 1, 3, oz, oz + 6, "metal");
  // cabin
  fillBox(grid, ox + 3, ox + 9, 4, 6, oz + 1, oz + 5, "metal");
  // cabin windows
  fillBox(grid, ox + 3, ox + 9, 4, 5, oz, oz, "glass");
  fillBox(grid, ox + 3, ox + 9, 4, 5, oz + 6, oz + 6, "glass");
  fillBox(grid, ox + 3, ox + 3, 4, 5, oz + 1, oz + 5, "glass");
  fillBox(grid, ox + 9, ox + 9, 4, 5, oz + 1, oz + 5, "glass");
  // wheels
  for (const [wx, wz] of [[ox + 1, oz], [ox + 1, oz + 6], [ox + 12, oz], [ox + 12, oz + 6]] as const) {
    fillBox(grid, wx, wx + 1, 0, 1, wz, wz, "metal");
  }
  // a car is a standalone prop, not load-bearing structure: mark it non-structural so its
  // body (which cantilevers over the wheels) isn't treated as "floating" and doesn't force
  // a huge overhang budget on the whole world.
  for (let x = ox; x <= ox + 13; x++)
    for (let y = 0; y <= 6; y++)
      for (let z = oz; z <= oz + 6; z++)
        if (grid.has(x, y, z)) grid.markSettled(x, y, z);
}

/** A small gas tank (cluster of explosive voxels) standing on the floor at (x,y,z). */
export function placeGasTank(grid: VoxelGrid, x: number, y: number, z: number): void {
  fillBox(grid, x, x + 1, y, y + 4, z, z + 1, "gastank");
}

/**
 * Multi-storey building with real interiors: concrete floor slabs, brick exterior +
 * interior dividing walls with doorways, glass windows, a stairwell hole between
 * floors, a roof, and gas tanks placed inside each storey.
 */
// Building layout — exported so the player can be spawned inside the ground-floor lobby.
// BIG doubles as the overall world footprint that buildDefaultScene fills with smaller plots.
export const BIG = { W: 288, D: 216, H: 18, FLOORS: 6 }; // fewer, taller storeys
/** Per-building size. Storey height (H) is fixed to BIG.H so STRIDE stays constant everywhere. */
export interface BuildSpec { W: number; D: number; FLOORS: number }
const STRIDE = BIG.H + 1;        // voxels between floor slabs
const COL = 14;                  // structural column spacing (≈50% fewer columns than before)
const ROOM_BAYS = 2;             // upper-floor rooms span this many column bays →
const ROOM = ROOM_BAYS * COL;    // big rooms (~28 voxels) whose walls fall on column lines
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
            clearBox(grid, wx, wx, base + 1, base + 8, c - 1, c + 1);
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
            clearBox(grid, c - 1, c + 1, base + 1, base + 8, wz, wz);
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
    if (wall === 0) clearBox(grid, px, px + 3, 1, 7, oz, oz);                 // front
    else if (wall === 1) clearBox(grid, px, px + 3, 1, 7, oz + D - 1, oz + D - 1); // back
    else if (wall === 2) clearBox(grid, ox, ox, 1, 7, pzFar, pzFar + 3);      // left (shaft side)
    else clearBox(grid, ox + W - 1, ox + W - 1, 1, 7, pz, pz + 3);            // right
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
}

export interface Placed { ox: number; oz: number; W: number; D: number; FLOORS: number }
const PLOTS_X = 5, PLOTS_Z = 4, STREET = 14; // 20 plots in the same footprint → more, smaller buildings
const PLOT_W = Math.floor(BIG.W / PLOTS_X), PLOT_D = Math.floor(BIG.D / PLOTS_Z);
/** Muted facade palette — brick plus the sombre wall tints; one is picked per building. */
const WALL_MATS: MaterialId[] = ["brick", "wall_slate", "wall_moss", "wall_clay", "wall_navy"];
let _placed: Placed[] = [];
/** The buildings placed by the last buildDefaultScene — used to site the DvH bases. */
export function placedBuildings(): readonly Placed[] { return _placed; }

/** A city block: many buildings on a 4×3 plot grid with wide streets between them — some "equal"
 *  (a fixed uniform size), some large landmarks, the rest randomised. Seeded rand() → every client
 *  generates the IDENTICAL block (destruction sync). */
export function buildDefaultScene(grid: VoxelGrid): void {
  grid.clear();
  _placed = [];
  for (let px = 0; px < PLOTS_X; px++)
    for (let pz = 0; pz < PLOTS_Z; pz++) {
      const i = px * PLOTS_Z + pz;
      let W: number, D: number, FLOORS: number;
      if (i % 7 === 0) {                                                                        // rare taller landmark
        W = PLOT_W - STREET; D = PLOT_D - STREET; FLOORS = 5 + Math.floor(rand() * 2);
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
  buildCar(grid, -16, 8); // parked outside, west of the block
}

// Drones-vs-Humans bases (destructible objectives). Each carries the voxel bounds of its structure.
export interface ObjSite { team: "drone" | "human"; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
/** Populated by buildObjectives from the placed buildings → dynamic but deterministic (seeded).
 *  [0] = drone base (rooftop), [1] = human base (inside a building). */
export let OBJECTIVE_SITES: ObjSite[] = [];

/**
 * Places the two team bases and records their bounds:
 *  - HUMAN base: a metal bunker in the lobby of a random building (drones must fly in to destroy it).
 *  - DRONE base: a metal landing pad + antenna on the roof of a random building (humans climb the
 *    stairs to the rooftop to destroy it).
 */
export function buildObjectives(grid: VoxelGrid): void {
  const b = _placed;
  OBJECTIVE_SITES = [];
  if (b.length < 2) return;
  const hi = Math.floor(rand() * b.length);
  let di = Math.floor(rand() * b.length); if (di === hi) di = (di + 1) % b.length;
  const hb = b[hi], db = b[di];

  const hx = hb.ox + (hb.W >> 1), hz = hb.oz + (hb.D >> 1);
  const human: ObjSite = { team: "human", x0: hx - 2, x1: hx + 2, y0: 1, y1: 5, z0: hz - 2, z1: hz + 2 };
  fillBox(grid, human.x0, human.x1, human.y0, human.y1, human.z0, human.z1, "metal");

  const dx = db.ox + (db.W >> 1), dz = db.oz + (db.D >> 1), ry = db.FLOORS * STRIDE;
  const drone: ObjSite = { team: "drone", x0: dx - 3, x1: dx + 3, y0: ry + 1, y1: ry + 4, z0: dz - 3, z1: dz + 3 };
  fillBox(grid, drone.x0, drone.x1, ry + 1, ry + 1, drone.z0, drone.z1, "metal"); // landing pad
  fillBox(grid, dx, dx, ry + 1, ry + 4, dz, dz, "metal");                         // antenna beacon

  OBJECTIVE_SITES = [drone, human];
}

/** An objective is alive while any voxel inside its bounds survives. `has` is grid.has (or a mock). */
export function objectiveAlive(site: ObjSite, has: (x: number, y: number, z: number) => boolean): boolean {
  for (let x = site.x0; x <= site.x1; x++)
    for (let y = site.y0; y <= site.y1; y++)
      for (let z = site.z0; z <= site.z1; z++)
        if (has(x, y, z)) return true;
  return false;
}
