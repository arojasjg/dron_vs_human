import { describe, it, expect } from "vitest";
import { VoxelGrid } from "../src/world/voxelGrid";
import { buildBuilding, buildDefaultScene, setWorldSeed } from "../src/build/prefabs";

const OVERHANG = 2; // must match game.ts CELL_OVERHANG

describe("structural collapse", () => {
  it("an intact city stands across seeds — no false floaters at the support budget", () => {
    for (const seed of [1, 3, 7, 13, 21, 34]) {
      setWorldSeed(seed);
      const grid = new VoxelGrid();
      buildDefaultScene(grid);
      expect(grid.fallenCells(OVERHANG), `city seed ${seed}`).toHaveLength(0);
    }
  });

  it("individual buildings of varied shape/height also stand intact at the budget", () => {
    const specs = [{ W: 34, D: 34, FLOORS: 2 }, { W: 60, D: 44, FLOORS: 5 }, { W: 88, D: 72, FLOORS: 6 }];
    for (const spec of specs) for (const seed of [2, 11, 29]) {
      setWorldSeed(seed);
      const grid = new VoxelGrid();
      buildBuilding(grid, 0, 0, spec);
      expect(grid.fallenCells(OVERHANG), `building ${spec.W}x${spec.D}x${spec.FLOORS} seed ${seed}`).toHaveLength(0);
    }
  });

  it("everything cut off from the ground falls", () => {
    setWorldSeed(7);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS: 4 });
    // sever the whole first storey (wide enough to also cut the external stairs + shaft walls)
    for (let x = -3; x <= 52; x++) for (let y = 8; y <= 30; y++) for (let z = -3; z <= 52; z++) grid.remove(x, y, z);
    expect(grid.fallenCells(OVERHANG).length).toBeGreaterThan(50); // the disconnected upper storeys drop
  });

  it("buildings carry subtle decoration (roof parapet + cornices), deterministic + no floaters", () => {
    setWorldSeed(5);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 44, D: 44, FLOORS: 4 });
    const roofY = 4 * 19;
    let parapet = 0; for (let x = 0; x < 44; x++) if (grid.has(x, roofY + 1, 0)) parapet++;
    let cornice = 0; for (let x = 0; x < 44; x++) if (grid.has(x, 19, -1)) cornice++; // ledge protruding in front
    expect(parapet).toBeGreaterThan(10);                 // a parapet rings the roof front
    expect(cornice).toBeGreaterThan(10);                 // a cornice ledge sticks out at the floor line
    expect(grid.fallenCells(OVERHANG)).toHaveLength(0);  // decoration doesn't float at the support budget

    // deterministic: same seed → identical decorated building
    setWorldSeed(9); const a = new VoxelGrid(); buildBuilding(a, 0, 0, { W: 50, D: 50, FLOORS: 4 });
    setWorldSeed(9); const b = new VoxelGrid(); buildBuilding(b, 0, 0, { W: 50, D: 50, FLOORS: 4 });
    expect(a.cells.size).toBe(b.cells.size);
  });

  it("the fix: a wide cantilever that the OLD budget (6) kept floating now falls at 2", () => {
    setWorldSeed(7);
    const grid = new VoxelGrid();
    buildBuilding(grid, 0, 0, { W: 60, D: 60, FLOORS: 3 });
    // gut the ground floor's interior → the storey above cantilevers far from the surviving perimeter
    for (let x = 8; x <= 52; x++) for (let y = 0; y <= 18; y++) for (let z = 8; z <= 52; z++) grid.remove(x, y, z);
    const fallTight = grid.fallenCells(2).length;
    const fallLoose = grid.fallenCells(6).length;
    expect(fallTight).toBeGreaterThan(fallLoose); // the tight budget drops what the loose one left hanging
  });
});
