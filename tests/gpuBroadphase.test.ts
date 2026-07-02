import { describe, it, expect } from "vitest";
import { exclusiveScan, inclusiveScan, scanWithTotal } from "../src/gpu/cpu/scan";
import { countingSortByCell } from "../src/gpu/cpu/countingSort";
import {
  makeGrid, numCells, cellCoord, cellIndex, computeCellKeys, buildNeighborGrid, forEachNeighbor,
} from "../src/gpu/cpu/neighborGrid";

describe("scan", () => {
  it("exclusive / inclusive / total", () => {
    expect([...exclusiveScan([3, 1, 0, 2])]).toEqual([0, 3, 4, 4]);
    expect([...inclusiveScan([3, 1, 0, 2])]).toEqual([3, 4, 4, 6]);
    const { scan, total } = scanWithTotal([3, 1, 0, 2]);
    expect([...scan]).toEqual([0, 3, 4, 4]);
    expect(total).toBe(6);
  });
  it("handles empty input", () => {
    expect(scanWithTotal([]).total).toBe(0);
  });
});

describe("countingSortByCell", () => {
  it("partitions every particle into its cell exactly once", () => {
    const keys = new Uint32Array([2, 0, 2, 1, 0, 2]);
    const { sortedIndices, cellStart } = countingSortByCell(keys, 3);
    // counts: cell0=2, cell1=1, cell2=3
    expect([...cellStart]).toEqual([0, 2, 3, 6]);
    // each cell's slice contains exactly the indices whose key == cell
    for (let c = 0; c < 3; c++) {
      const slice = [...sortedIndices.slice(cellStart[c], cellStart[c + 1])];
      for (const idx of slice) expect(keys[idx]).toBe(c);
      // stable: ascending original index within the cell
      expect(slice).toEqual([...slice].sort((a, b) => a - b));
    }
    expect(sortedIndices.length).toBe(6);
  });
});

describe("neighbor grid", () => {
  const g = makeGrid(1, [0, 0, 0], [10, 10, 10]);

  it("maps positions to cells and indexes them", () => {
    expect(cellCoord(g, 0.5, 0.5, 0.5)).toEqual([0, 0, 0]);
    expect(cellCoord(g, 5.5, 2.5, 9.9)).toEqual([5, 2, 9]);
    expect(cellCoord(g, -5, 999, 0)).toEqual([0, 9, 0]); // clamped to domain
    expect(cellIndex(g, 1, 0, 0)).toBe(1);
    expect(numCells(g)).toBe(1000);
  });

  it("visits near particles and skips far ones", () => {
    //              0:(5,5,5)   1:(5.6,5,5) near   2:(9,9,9) far
    const pos = new Float32Array([5, 5, 5, 5.6, 5, 5, 9, 9, 9]);
    const ng = buildNeighborGrid(g, pos, 3);
    expect([...computeCellKeys(g, pos, 3)]).toEqual([cellIndex(g, 5, 5, 5), cellIndex(g, 5, 5, 5), cellIndex(g, 9, 9, 9)]);
    const seen: number[] = [];
    forEachNeighbor(ng, pos, 0, (j) => seen.push(j));
    expect(seen).toContain(1);
    expect(seen).not.toContain(2);
    expect(seen).not.toContain(0); // never visits itself
  });
});
