import { exclusiveScan } from "./scan.ts";

export interface CellSort {
  /** Particle indices grouped by cell (stable within a cell, ascending index). */
  sortedIndices: Uint32Array;
  /** cellStart[c]..cellStart[c+1] is the slice of sortedIndices in cell c. Length numCells+1. */
  cellStart: Uint32Array;
}

/**
 * CPU reference twin of the GPU spatial-hash broadphase: histogram of per-cell
 * counts -> exclusive scan -> scatter. On the GPU the histogram uses atomics and
 * the scan is the parallel prefix-sum; the result layout is identical.
 */
export function countingSortByCell(cellKeys: Uint32Array, numCells: number): CellSort {
  const counts = new Uint32Array(numCells);
  for (let i = 0; i < cellKeys.length; i++) counts[cellKeys[i]]++;

  const start = exclusiveScan(counts);
  const cellStart = new Uint32Array(numCells + 1);
  cellStart.set(start);
  cellStart[numCells] = cellKeys.length;

  const cursor = Uint32Array.from(start);
  const sortedIndices = new Uint32Array(cellKeys.length);
  for (let i = 0; i < cellKeys.length; i++) {
    const c = cellKeys[i];
    sortedIndices[cursor[c]++] = i;
  }
  return { sortedIndices, cellStart };
}
