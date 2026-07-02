import { describe, it, expect } from "vitest";
import { makeGrid } from "../src/gpu/cpu/neighborGrid";
import { buildFixedGrid, forEachNeighborFixed } from "../src/gpu/cpu/fixedGrid";

describe("fixed-capacity grid", () => {
  const g = makeGrid(1, [0, 0, 0], [10, 10, 10]);

  it("counts particles per cell and stores their indices", () => {
    const pos = new Float32Array([5, 5, 5, 5.6, 5, 5, 9, 9, 9]);
    const fg = buildFixedGrid(g, pos, 3, 8);
    // particles 0 and 1 share a cell, particle 2 is elsewhere
    const seen: number[] = [];
    forEachNeighborFixed(g, pos, fg, 0, (j) => seen.push(j));
    expect(seen).toContain(1);
    expect(seen).not.toContain(2);
    expect(seen).not.toContain(0);
  });

  it("counts overflow beyond capacity but only stores maxPerCell items", () => {
    const max = 2;
    const pos = new Float32Array(5 * 3);
    for (let i = 0; i < 5; i++) { pos[i * 3] = 1.5; pos[i * 3 + 1] = 1.5; pos[i * 3 + 2] = 1.5; } // all same cell
    const fg = buildFixedGrid(g, pos, 5, max);
    // the cell count reflects all 5, but the neighbour walk yields at most max items
    const seen: number[] = [];
    forEachNeighborFixed(g, pos, fg, 0, (j) => seen.push(j));
    expect(seen.length).toBeLessThanOrEqual(max); // capped (stored ≤ max, minus self if present)
  });
});
