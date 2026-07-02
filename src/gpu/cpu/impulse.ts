export interface ImpulseParams {
  center: [number, number, number];
  radius: number;
  strength: number;
}

/**
 * CPU reference twin of impulse.wgsl: radial velocity impulse (with upward bias)
 * to every grain within `radius` of `center`, falling off linearly. An explosion.
 */
export function applyImpulse(positions: Float32Array, velocities: Float32Array, n: number, p: ImpulseParams): void {
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - p.center[0];
    const dy = positions[i * 3 + 1] - p.center[1];
    const dz = positions[i * 3 + 2] - p.center[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= p.radius) continue;
    const f = (1 - dist / p.radius) * p.strength;
    const inv = dist > 1e-6 ? 1 / dist : 0;
    velocities[i * 3] += dx * inv * f;
    velocities[i * 3 + 1] += dy * inv * f + f * 0.4;
    velocities[i * 3 + 2] += dz * inv * f;
  }
}
