import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { VoxelGrid } from "../src/world/voxelGrid";
import { VoxelCollider } from "../src/world/voxelCollider";
import { buildBuilding, stairShaft, setWorldSeed } from "../src/build/prefabs";
import { VOXEL } from "../src/config";

beforeAll(async () => { await RAPIER.init(); });

const box = (w: RAPIER.World, hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));

/** Peak height a Walker gains driving forward (+z) up a step profile from a landing at z<0. */
function climbPeak(build: (w: RAPIER.World) => void, frames = 240): number {
  const physics = new Physics();
  physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
  const walker = new Walker(physics);
  box(physics.world, 2, 0.5, 1.2, 0, -0.5, -1.2); // landing top y=0
  build(physics.world);
  walker.spawn(0, 0.85, -0.8);
  for (let i = 0; i < 30; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); }
  const y0 = walker.position.y;
  let peak = y0;
  for (let i = 0; i < frames; i++) { walker.move(1 / 60, 0, 4.5, false); physics.world.step(); peak = Math.max(peak, walker.position.y); }
  return +(peak - y0).toFixed(2);
}

/** True if a capsule-sized apron in front of the ground flight's low step is open (boardable). */
function groundFlightBoardable(W: number, D: number, FLOORS: number, seed: number): boolean {
  setWorldSeed(seed);
  const grid = new VoxelGrid();
  buildBuilding(grid, 0, 0, { W, D, FLOORS });
  const s = stairShaft(0, 0);
  for (let x = s.x0; x <= s.x1; x++)
    for (let y = 1; y <= 7; y++)                 // ~1.75 m of standing headroom
      for (let z = s.z0 - 3; z <= s.z0 - 1; z++) // the approach apron just before the first step
        if (grid.has(x, y, z)) return false;
  return true;
}

describe("stairs — climbable and boardable", () => {
  it("a Walker climbs a full 4.75 m storey on the 45° voxel stair profile", () => {
    // the real voxel stair: 19 thin floating treads (1-voxel tread, 1-voxel rise), open underneath
    const peak = climbPeak((w) => {
      for (let i = 0; i < 19; i++) box(w, 1.5, 0.125, 0.125, 0, (i + 1) * 0.25 - 0.125, i * 0.25);
    });
    expect(peak).toBeGreaterThan(4.0); // reaches the next floor (STRIDE = 4.75 m)
  });

  it("the ground flight is boardable — a clear apron sits in front of the low step, not a wall", () => {
    // the smallest buildings (W=D=34) and a few seeds — the worst case for a jammed corner
    for (const [W, D, F, seed] of [[40, 40, 3, 1], [34, 34, 2, 7], [34, 40, 3, 3], [43, 40, 6, 5]] as const)
      expect(groundFlightBoardable(W, D, F, seed)).toBe(true);
  });

  it("every stair step has capsule headroom above it — the landing never overhangs the last steps", () => {
    setWorldSeed(1);
    const grid = new VoxelGrid();
    const FLOORS = 3, STRIDE = 19;
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS });
    const sh = stairShaft(0, 0);
    const HEAD = 7; // ~1.75 m of clearance for the capsule standing on a step
    for (let s = 0; s < FLOORS; s++) {
      const base = s * STRIDE, even = s % 2 === 0;
      const laneMid = even ? sh.x0 + 1 : sh.x1 - 1;
      for (let i = 1; i <= STRIDE; i++) {
        const z = even ? sh.z0 + i - 1 : sh.z1 - (i - 1);
        for (let dy = 1; dy <= HEAD; dy++)
          expect(grid.has(laneMid, base + i + dy, z)).toBe(false); // nothing (esp. the landing) over the step
      }
    }
  });

  it("an external fire-escape climbs the east wall from the ground to the roof, with no gap too tall", () => {
    setWorldSeed(1);
    const grid = new VoxelGrid();
    const W = 40, D = 40, FLOORS = 3, STRIDE = 19;
    buildBuilding(grid, 0, 0, { W, D, FLOORS });
    const x0 = W, EXT_OUT = 6;           // external tread columns (ox = 0), two lanes
    const roofY = FLOORS * STRIDE;
    const treadAt = (y: number) => { for (let x = x0; x < x0 + EXT_OUT; x++) for (let z = 0; z < D; z++) if (grid.get(x, y, z) === "metal") return true; return false; };
    expect(treadAt(0) || treadAt(1)).toBe(true);             // boardable at ground level
    expect(treadAt(roofY - 1) || treadAt(roofY)).toBe(true); // reaches the roof
    for (let y = 1; y <= roofY; y++) expect(treadAt(y - 1) || treadAt(y)).toBe(true); // no gap too tall

    // …and each external step has capsule headroom above it (the forward landing never overhangs it)
    const z0 = 4, z1 = z0 + STRIDE - 1;  // external flight z-range (oz + 4)
    for (let s = 0; s < FLOORS; s++) {
      const base = s * STRIDE, even = s % 2 === 0;
      const laneMid = even ? x0 + 1 : x0 + EXT_OUT - 2;      // near-wall vs outer lane centre
      for (let i = 1; i <= STRIDE; i++) {
        const z = even ? z0 + i - 1 : z1 - (i - 1);
        for (let dy = 1; dy <= 7; dy++) expect(grid.has(laneMid, base + i + dy, z)).toBe(false);
      }
    }
  });

  it("a Walker boards flight 0 in the REAL building and climbs it to the floor-1 landing", () => {
    setWorldSeed(1);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS: 3 });
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    new VoxelCollider(physics).rebuildAll(grid);           // the actual building colliders, stairs and all
    const walker = new Walker(physics);
    const sh = stairShaft(0, 0);
    walker.spawn((sh.x0 + 1) * VOXEL, 1.4, (sh.z0 - 2) * VOXEL); // foot of flight 0 (west lane), on the lobby floor
    let peak = 0;
    for (let i = 0; i < 30; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); }        // settle onto the floor
    for (let i = 0; i < 340; i++) { walker.move(1 / 60, 0, 4.5, false); physics.world.step(); peak = Math.max(peak, walker.position.y); }
    // a storey is 4.75 m; reaching the landing proves the boarding fix AND the full-flight climb in situ
    expect(peak).toBeGreaterThan(4.3);
  });
});
