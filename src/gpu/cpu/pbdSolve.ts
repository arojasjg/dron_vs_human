import { buildNeighborGrid, forEachNeighbor, type Grid } from "./neighborGrid.ts";

export interface PbdParams {
  /** Particle radius; rest separation between two particles is 2*radius. */
  radius: number;
  iterations: number;
  /** Ground plane height; particles rest at groundY + radius. */
  groundY?: number;
  /** Position-correction relaxation in [0,1]. */
  stiffness?: number;
}

/**
 * CPU reference twin of the GPU PBD contact solver. Jacobi style: each iteration
 * computes all position corrections from the current positions (via the neighbour
 * grid), then applies them — so it is deterministic and order-independent, exactly
 * like the GPU kernel. Mutates `positions` (packed xyz) in place.
 */
export function pbdSolve(g: Grid, positions: Float32Array, n: number, params: PbdParams): void {
  const r = params.radius;
  const d0 = 2 * r;
  const d02 = d0 * d0;
  const stiffness = params.stiffness ?? 1;
  const groundY = params.groundY ?? 0;

  const dx = new Float32Array(n * 3);
  const cnt = new Uint32Array(n);

  for (let iter = 0; iter < params.iterations; iter++) {
    dx.fill(0);
    cnt.fill(0);
    const ng = buildNeighborGrid(g, positions, n);

    for (let i = 0; i < n; i++) {
      forEachNeighbor(ng, positions, i, (j) => {
        if (j <= i) return; // resolve each pair once
        const ax = positions[i * 3] - positions[j * 3];
        const ay = positions[i * 3 + 1] - positions[j * 3 + 1];
        const az = positions[i * 3 + 2] - positions[j * 3 + 2];
        const dist2 = ax * ax + ay * ay + az * az;
        if (dist2 >= d02 || dist2 < 1e-12) return;
        const dist = Math.sqrt(dist2);
        const half = ((d0 - dist) * 0.5 * stiffness) / dist;
        dx[i * 3] += ax * half; dx[i * 3 + 1] += ay * half; dx[i * 3 + 2] += az * half;
        dx[j * 3] -= ax * half; dx[j * 3 + 1] -= ay * half; dx[j * 3 + 2] -= az * half;
        cnt[i]++; cnt[j]++;
      });
    }

    for (let i = 0; i < n; i++) {
      const k = cnt[i] > 0 ? 1 / cnt[i] : 0;
      positions[i * 3] += dx[i * 3] * k;
      positions[i * 3 + 1] += dx[i * 3 + 1] * k;
      positions[i * 3 + 2] += dx[i * 3 + 2] * k;
      const minY = groundY + r;
      if (positions[i * 3 + 1] < minY) positions[i * 3 + 1] = minY;
    }
  }
}
