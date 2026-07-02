export interface WorldParams {
  minX: number; maxX: number; minZ: number; maxZ: number;
  groundY: number;
  radius: number;
}

/**
 * CPU reference twin of worldCollide.wgsl: projects each grain back inside the box
 * container (and onto the floor). In-place on packed-xyz positions.
 */
export function worldCollide(positions: Float32Array, n: number, w: WorldParams): void {
  const r = w.radius;
  for (let i = 0; i < n; i++) {
    const b = i * 3;
    positions[b] = Math.min(Math.max(positions[b], w.minX + r), w.maxX - r);
    positions[b + 1] = Math.max(positions[b + 1], w.groundY + r);
    positions[b + 2] = Math.min(Math.max(positions[b + 2], w.minZ + r), w.maxZ - r);
  }
}
