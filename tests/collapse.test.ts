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

const CELL_MIN_MASS = 12; // must match game.ts

describe("collapse mass threshold — a sliver can't suspend a tower ('one block holding everything')", () => {
  it("intact buildings STILL stand with the mass floor applied (no false collapse) across seeds/shapes", () => {
    const specs = [{ W: 34, D: 34, FLOORS: 2 }, { W: 60, D: 44, FLOORS: 5 }, { W: 88, D: 72, FLOORS: 6 }];
    for (const spec of specs) for (const seed of [2, 7, 11, 29]) {
      setWorldSeed(seed);
      const grid = new VoxelGrid();
      buildBuilding(grid, 0, 0, spec);
      expect(grid.fallenCells(OVERHANG, CELL_MIN_MASS), `intact ${spec.W}x${spec.D}x${spec.FLOORS} seed ${seed}`).toHaveLength(0);
    }
  });

  it("a whole city block stands intact under the mass floor (no floaters across seeds)", () => {
    for (const seed of [1, 3, 7, 13, 21, 34]) {
      setWorldSeed(seed);
      const grid = new VoxelGrid();
      buildDefaultScene(grid);
      expect(grid.fallenCells(OVERHANG, CELL_MIN_MASS), `city seed ${seed}`).toHaveLength(0);
    }
  });

  it("a tower whittled down to a single 1-voxel-wide base sliver: floated before, collapses now", () => {
    // a solid 2m-footprint tower, 3 cells (24 voxels) tall → cells (0,0,0),(0,1,0),(0,2,0)
    const grid = new VoxelGrid();
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) for (let y = 0; y < 24; y++) grid.set(x, y, z, "concrete");
    // gut the ground cell to a single 1×1 column (8 voxels) — the "one block" left holding it all
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) {
      if (x === 0 && z === 0) continue;               // keep the sliver
      for (let y = 0; y < 8; y++) grid.remove(x, y, z);
    }
    const slivMass = 8; // 1×1×8
    expect(slivMass).toBeLessThan(CELL_MIN_MASS);      // the remnant is below the load-bearing floor

    // OLD model (mass 0): the 8-voxel sliver anchors and suspends both full cells above → almost nothing falls
    const floatedBefore = grid.fallenCells(OVERHANG, 0).length;
    expect(floatedBefore).toBeLessThanOrEqual(1);

    // NEW model: the sliver can't bear the tower → the suspended cells above lose their ground path and fall
    const fallsNow = grid.fallenCells(OVERHANG, CELL_MIN_MASS);
    expect(fallsNow.length).toBeGreaterThanOrEqual(2); // the two full cells above the sliver come down
  });
});

const PANCAKE_FRAC = 0.5; // must match game.ts

describe("pancake collapse — destroy a lower storey and the floors above come DOWN", () => {
  it("intact buildings + city do NOT false-pancake (a natural taper is not a blown-out storey)", () => {
    const specs = [{ W: 34, D: 34, FLOORS: 2 }, { W: 44, D: 44, FLOORS: 5 }, { W: 60, D: 44, FLOORS: 5 }, { W: 88, D: 72, FLOORS: 6 }, { W: 50, D: 30, FLOORS: 8 }];
    for (const spec of specs) for (const seed of [2, 4, 7, 11, 13, 29]) {
      setWorldSeed(seed); const g = new VoxelGrid(); buildBuilding(g, 0, 0, spec);
      expect(g.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC), `intact ${spec.W}x${spec.D}x${spec.FLOORS} seed ${seed}`).toHaveLength(0);
    }
    for (const seed of [1, 3, 7, 13, 21, 34]) {
      setWorldSeed(seed); const g = new VoxelGrid(); buildDefaultScene(g);
      expect(g.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC), `city seed ${seed}`).toHaveLength(0);
    }
  });

  it("blowing out half of the ground storey pancakes the floors above (the user's case)", () => {
    const spec = { W: 44, D: 44, FLOORS: 5 }, STOREY = 19;
    for (const seed of [2, 7, 13]) {
      setWorldSeed(seed); const g = new VoxelGrid(); buildBuilding(g, 0, 0, spec);
      const before = g.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC).length;
      expect(before).toBe(0); // intact: nothing pancaking yet
      // blow out ~half the ground storey across its full height
      for (let x = -4; x <= spec.W / 2; x++) for (let y = 0; y <= STOREY - 1; y++) for (let z = -4; z <= spec.D + 4; z++) g.remove(x, y, z);
      const after = g.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC).length;
      expect(after, `seed ${seed}`).toBeGreaterThan(100); // the storeys above come down, not float
    }
  });

  it("a single voxel removed does NOT pancake a building (only substantial destruction does)", () => {
    setWorldSeed(7); const g = new VoxelGrid(); buildBuilding(g, 0, 0, { W: 44, D: 44, FLOORS: 5 });
    g.remove(10, 4, 10); // one chipped voxel
    expect(g.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC)).toHaveLength(0);
  });
});

describe("cached per-cell mass — incremental maintenance matches a from-scratch build", () => {
  const sorted = (a: number[]) => [...a].sort((p, q) => p - q);
  it("survives a history of set → markWeak → remove and still solves identically", () => {
    // A: built through a sequence of mutations (the cache is maintained incrementally)
    const a = new VoxelGrid();
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 20; y++) a.set(x, y, z, "concrete");
    a.markWeakBox(0, 1, 0, 19, 0, 1);                       // a weak (non-anchoring) column
    for (let x = 3; x < 9; x++) for (let z = 3; z < 9; z++) for (let y = 0; y < 8; y++) a.remove(x, y, z); // gut a base region

    // B: built clean straight to the SAME final state
    const b = new VoxelGrid();
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 20; y++) {
      const gutted = x >= 3 && x < 9 && z >= 3 && z < 9 && y < 8;
      if (!gutted) b.set(x, y, z, "concrete");
    }
    b.markWeakBox(0, 1, 0, 19, 0, 1);

    // identical final state → identical support solves ⇒ A's incrementally-cached mass is correct
    expect(sorted(a.fallenCells(2, 12))).toEqual(sorted(b.fallenCells(2, 12)));
    expect(sorted(a.pancakeCells(12, 0.5))).toEqual(sorted(b.pancakeCells(12, 0.5)));
  });
});
