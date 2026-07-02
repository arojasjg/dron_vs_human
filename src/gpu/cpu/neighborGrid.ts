import { countingSortByCell, type CellSort } from "./countingSort.ts";

/** Uniform grid covering a bounded domain. Mirrors the GPU uniform block layout. */
export interface Grid {
  cellSize: number;
  originX: number;
  originY: number;
  originZ: number;
  dimX: number;
  dimY: number;
  dimZ: number;
}

export function makeGrid(cellSize: number, origin: [number, number, number], dim: [number, number, number]): Grid {
  return {
    cellSize,
    originX: origin[0], originY: origin[1], originZ: origin[2],
    dimX: dim[0], dimY: dim[1], dimZ: dim[2],
  };
}

export const numCells = (g: Grid): number => g.dimX * g.dimY * g.dimZ;

const clampCell = (v: number, dim: number): number => (v < 0 ? 0 : v >= dim ? dim - 1 : v);

/** World position -> clamped integer cell coordinate. */
export function cellCoord(g: Grid, x: number, y: number, z: number): [number, number, number] {
  return [
    clampCell(Math.floor((x - g.originX) / g.cellSize), g.dimX),
    clampCell(Math.floor((y - g.originY) / g.cellSize), g.dimY),
    clampCell(Math.floor((z - g.originZ) / g.cellSize), g.dimZ),
  ];
}

export function cellIndex(g: Grid, cx: number, cy: number, cz: number): number {
  return (cz * g.dimY + cy) * g.dimX + cx;
}

/** Linear cell key per particle (positions packed xyz). */
export function computeCellKeys(g: Grid, positions: Float32Array, n: number): Uint32Array {
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const [cx, cy, cz] = cellCoord(g, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    keys[i] = cellIndex(g, cx, cy, cz);
  }
  return keys;
}

export interface NeighborGrid {
  grid: Grid;
  keys: Uint32Array;
  sort: CellSort;
}

export function buildNeighborGrid(g: Grid, positions: Float32Array, n: number): NeighborGrid {
  const keys = computeCellKeys(g, positions, n);
  const sort = countingSortByCell(keys, numCells(g));
  return { grid: g, keys, sort };
}

/**
 * Visits every particle in the 3x3x3 cell neighbourhood of particle i (excluding i).
 * This is the access pattern the GPU collision kernel uses against the sorted grid.
 */
export function forEachNeighbor(
  ng: NeighborGrid,
  positions: Float32Array,
  i: number,
  cb: (j: number) => void,
): void {
  const g = ng.grid;
  const [cx, cy, cz] = cellCoord(g, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  for (let dz = -1; dz <= 1; dz++) {
    const z = cz + dz;
    if (z < 0 || z >= g.dimZ) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= g.dimY) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= g.dimX) continue;
        const c = cellIndex(g, x, y, z);
        const end = ng.sort.cellStart[c + 1];
        for (let s = ng.sort.cellStart[c]; s < end; s++) {
          const j = ng.sort.sortedIndices[s];
          if (j !== i) cb(j);
        }
      }
    }
  }
}
