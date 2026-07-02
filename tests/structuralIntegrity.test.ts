import { describe, it, expect } from "vitest";
import { findFloatingVoxels, findUnsupported, connectedComponents, type Voxel } from "../src/world/structuralIntegrity";

function gridFrom(cells: Voxel[]) {
  const set = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  return {
    solid: (x: number, y: number, z: number) => set.has(`${x},${y},${z}`),
    anchored: (_x: number, y: number, _z: number) => y === 0,
  };
}

describe("findFloatingVoxels", () => {
  it("keeps a column standing while it touches the ground", () => {
    const col: Voxel[] = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]];
    const g = gridFrom(col);
    expect(findFloatingVoxels(col, g.solid, g.anchored)).toEqual([]);
  });

  it("detects the upper part as floating once the base is cut", () => {
    // base (y=0) removed → the rest is disconnected from the ground
    const broken: Voxel[] = [[0, 1, 0], [0, 2, 0], [0, 3, 0]];
    const g = gridFrom(broken);
    const floating = findFloatingVoxels(broken, g.solid, g.anchored);
    expect(floating.length).toBe(3);
  });

  it("only the unsupported overhang falls, the supported stack stays", () => {
    const cells: Voxel[] = [
      [0, 0, 0], [0, 1, 0],          // supported column
      [5, 2, 0], [6, 2, 0],          // floating overhang far away
    ];
    const g = gridFrom(cells);
    const floating = findFloatingVoxels(cells, g.solid, g.anchored);
    expect(new Set(floating.map((c) => c.join(",")))).toEqual(new Set(["5,2,0", "6,2,0"]));
  });
});

describe("findUnsupported (load-bearing support)", () => {
  it("keeps a wall standing on the ground", () => {
    const wall: Voxel[] = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]];
    const g = gridFrom(wall);
    expect(findUnsupported(wall, g.solid, g.anchored, 4)).toEqual([]);
  });

  it("drops a wall that only hangs from above (no base to the ground)", () => {
    const cells: Voxel[] = [
      [0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0], [0, 4, 0], [0, 5, 0], // column to ground
      [1, 5, 0], [2, 5, 0], [3, 5, 0],                                  // beam across the top
      [3, 4, 0], [3, 3, 0], [3, 2, 0],                                  // wall hanging off the beam end
    ];
    const g = gridFrom(cells);
    const fell = new Set(findUnsupported(cells, g.solid, g.anchored, 8).map((c) => c.join(",")));
    expect(fell.has("3,4,0")).toBe(true);
    expect(fell.has("3,3,0")).toBe(true);
    expect(fell.has("3,2,0")).toBe(true);
    expect(fell.has("0,0,0")).toBe(false);
    expect(fell.has("3,5,0")).toBe(false);
  });

  it("collapses the slab beyond a thin column's overhang reach", () => {
    const cells: Voxel[] = [];
    for (let y = 0; y <= 4; y++) cells.push([0, y, 0]);   // thin column to the ground
    for (let x = 0; x <= 10; x++) cells.push([x, 4, 0]);  // wide slab resting on the column top
    const g = gridFrom(cells);
    const fell = new Set(findUnsupported(cells, g.solid, g.anchored, 3).map((c) => c.join(",")));
    expect(fell.has("1,4,0")).toBe(false);
    expect(fell.has("3,4,0")).toBe(false);
    expect(fell.has("8,4,0")).toBe(true);  // 8 from the column > overhang budget 3
    expect(fell.has("10,4,0")).toBe(true);
  });
});

describe("connectedComponents", () => {
  it("separates two disjoint clusters into two islands", () => {
    const cells: Voxel[] = [
      [0, 0, 0], [1, 0, 0],          // island A
      [10, 0, 0], [10, 1, 0],        // island B
    ];
    const comps = connectedComponents(cells);
    expect(comps.length).toBe(2);
    expect(comps.map((c) => c.length).sort()).toEqual([2, 2]);
  });

  it("treats a single connected blob as one island", () => {
    const cells: Voxel[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]];
    expect(connectedComponents(cells).length).toBe(1);
  });
});
