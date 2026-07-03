import { describe, it, expect } from "vitest";
import { VoxelGrid, unpackKey } from "../src/world/voxelGrid";
import { buildBuilding, setWorldSeed } from "../src/build/prefabs";

const STRIDE = 19, OVERHANG = 2;
const KEY = (k: number) => { const [x, y, z] = unpackKey(k); return { x, y, z }; };

// settle the collapse to steady state (like collapseStep run to completion)
function settle(grid: VoxelGrid): void {
  for (let iter = 0; iter < 200; iter++) {
    const fallen = grid.fallenCells(OVERHANG);
    if (fallen.length === 0) return;
    for (const ck of fallen) for (const k of grid.cellVoxelKeys(ck)) { const p = KEY(k); grid.remove(p.x, p.y, p.z); }
  }
}
function voxelsAbove(grid: VoxelGrid, y0: number): number {
  let n = 0;
  for (const k of grid.cells.keys()) if (unpackKey(k)[1] >= y0) n++;
  return n;
}

describe("REPRO: destroy the whole first storey (user report)", () => {
  it("A: remove the ground storey across the FULL extent → everything above collapses", () => {
    setWorldSeed(7);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS: 4 });
    const upperBefore = voxelsAbove(grid, STRIDE);
    for (let x = -4; x <= 52; x++) for (let y = 0; y < STRIDE; y++) for (let z = -4; z <= 52; z++) grid.remove(x, y, z);
    settle(grid);
    const upperAfter = voxelsAbove(grid, STRIDE);
    console.log("CASE A (full-extent ground removal): upper voxels before/after settle =", upperBefore, upperAfter);
    expect(upperAfter).toBe(0);
  });

  it("B: remove only the FOOTPRINT ground storey (fire-escape survives) → measure floaters", () => {
    setWorldSeed(7);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS: 4 });
    const upperBefore = voxelsAbove(grid, STRIDE);
    // remove the ENTIRE footprint incl. exterior walls (x,z 0..43); leave the east fire-escape (x≥44)
    for (let x = 0; x <= 43; x++) for (let y = 0; y < STRIDE; y++) for (let z = 0; z <= 43; z++) grid.remove(x, y, z);
    settle(grid);
    const upperAfter = voxelsAbove(grid, STRIDE);
    console.log("CASE B (full footprint gone, only fire-escape survives): upper voxels before/after =", upperBefore, upperAfter);
    expect(upperAfter).toBe(0); // EXPECT collapse; if this fails, the surviving stairs float the building
  });
});
