import { cellCoord, cellIndex, numCells, type Grid } from "./neighborGrid.ts";

/**
 * Fixed-capacity uniform grid: each cell holds up to `maxPerCell` particle indices,
 * inserted with an atomic bump on the GPU. Cheap, scan-free broadphase that scales to
 * millions with ~maxPerCell*4 bytes per cell. CPU reference twin of gridFill.wgsl.
 */
export interface FixedGrid {
  cellCount: Uint32Array;
  cellItems: Uint32Array;
  maxPerCell: number;
}

export function buildFixedGrid(g: Grid, positions: Float32Array, n: number, maxPerCell: number): FixedGrid {
  const nc = numCells(g);
  const cellCount = new Uint32Array(nc);
  const cellItems = new Uint32Array(nc * maxPerCell);
  for (let i = 0; i < n; i++) {
    const [cx, cy, cz] = cellCoord(g, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const c = cellIndex(g, cx, cy, cz);
    const slot = cellCount[c]++;
    if (slot < maxPerCell) cellItems[c * maxPerCell + slot] = i;
  }
  return { cellCount, cellItems, maxPerCell };
}

/** Visits every stored particle in the 3x3x3 neighbourhood of particle i (excluding i). */
export function forEachNeighborFixed(
  g: Grid,
  positions: Float32Array,
  fg: FixedGrid,
  i: number,
  cb: (j: number) => void,
): void {
  const [cx, cy, cz] = cellCoord(g, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  for (let dz = -1; dz <= 1; dz++) {
    const z = cz + dz; if (z < 0 || z >= g.dimZ) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy; if (y < 0 || y >= g.dimY) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx; if (x < 0 || x >= g.dimX) continue;
        const c = cellIndex(g, x, y, z);
        const count = Math.min(fg.cellCount[c], fg.maxPerCell);
        for (let s = 0; s < count; s++) {
          const j = fg.cellItems[c * fg.maxPerCell + s];
          if (j !== i) cb(j);
        }
      }
    }
  }
}
