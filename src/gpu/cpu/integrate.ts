export interface IntegrateParams {
  dt: number;
  /** Gravity acceleration (negative = down). */
  gravity: number;
  /** Per-step linear damping in [0,1]; 0 = none. */
  damping?: number;
  /** Optional wind the velocity relaxes toward. */
  wind?: [number, number, number];
  /** 0..1 coupling toward the wind. */
  windCoupling?: number;
}

/**
 * CPU reference twin of the GPU integrate kernel: semi-implicit Euler with gravity,
 * damping and optional wind. Mutates positions/velocities (packed xyz) in place.
 */
export function integrate(
  positions: Float32Array,
  velocities: Float32Array,
  n: number,
  p: IntegrateParams,
): void {
  const damp = 1 - (p.damping ?? 0);
  const wc = p.windCoupling ?? 0;
  const wx = p.wind ? p.wind[0] : 0, wy = p.wind ? p.wind[1] : 0, wz = p.wind ? p.wind[2] : 0;
  for (let i = 0; i < n; i++) {
    let vx = velocities[i * 3], vy = velocities[i * 3 + 1], vz = velocities[i * 3 + 2];
    vy += p.gravity * p.dt;
    vx += (wx - vx) * wc * p.dt;
    vy += (wy - vy) * wc * p.dt;
    vz += (wz - vz) * wc * p.dt;
    vx *= damp; vy *= damp; vz *= damp;
    velocities[i * 3] = vx; velocities[i * 3 + 1] = vy; velocities[i * 3 + 2] = vz;
    positions[i * 3] += vx * p.dt;
    positions[i * 3 + 1] += vy * p.dt;
    positions[i * 3 + 2] += vz * p.dt;
  }
}
