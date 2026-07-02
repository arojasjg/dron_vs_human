// CPU reference twin of the MLS-MPM (Moving Least Squares Material Point Method)
// fluid solver — the canonical compact formulation (Hu et al. 2018), in 3D. The GPU
// kernels (P2G with fixed-point atomics, grid update, G2P) are transcriptions of this.
//
// Particle state (Structure of Arrays, packed):
//   pos[n*3], vel[n*3], C[n*9] (3x3 affine velocity), J[n] (volume ratio)
// Grid state:
//   gridMass[nodes], gridVel[nodes*3] (momentum during P2G, velocity after update)

export interface MpmGrid {
  dx: number; invDx: number;
  ox: number; oy: number; oz: number;
  dimX: number; dimY: number; dimZ: number;
  dt: number; gravity: number;
  mass: number; vol: number;
  /** bulk modulus (stiffness of the weakly-compressible fluid). */
  E: number;
}

export const mpmNumNodes = (g: MpmGrid): number => g.dimX * g.dimY * g.dimZ;

const nodeIndex = (g: MpmGrid, x: number, y: number, z: number): number =>
  (z * g.dimY + y) * g.dimX + x;

/** Quadratic B-spline data for one particle. */
interface Stencil {
  base: [number, number, number];
  // weights per axis: w[axis][0..2]
  wx: [number, number, number];
  wy: [number, number, number];
  wz: [number, number, number];
  fx: [number, number, number];
}

function stencil(g: MpmGrid, px: number, py: number, pz: number): Stencil {
  const gx = (px - g.ox) * g.invDx, gy = (py - g.oy) * g.invDx, gz = (pz - g.oz) * g.invDx;
  const bx = Math.floor(gx - 0.5), by = Math.floor(gy - 0.5), bz = Math.floor(gz - 0.5);
  const fx = gx - bx, fy = gy - by, fz = gz - bz;
  const w = (f: number): [number, number, number] => [
    0.5 * (1.5 - f) ** 2,
    0.75 - (f - 1.0) ** 2,
    0.5 * (f - 0.5) ** 2,
  ];
  return { base: [bx, by, bz], wx: w(fx), wy: w(fy), wz: w(fz), fx: [fx, fy, fz] };
}

/** Particles -> grid: scatter mass and momentum (including stress + affine). */
export function p2g(
  g: MpmGrid, pos: Float32Array, vel: Float32Array, C: Float32Array, J: Float32Array, n: number,
  gridMass: Float32Array, gridVel: Float32Array,
): void {
  gridMass.fill(0);
  gridVel.fill(0);

  for (let p = 0; p < n; p++) {
    const s = stencil(g, pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]);
    // weakly-compressible fluid stress (isotropic scalar)
    const stress = -g.dt * g.vol * (J[p] - 1) * 4 * g.invDx * g.invDx * g.E;
    // affine = stress*I + mass*C   (3x3)
    const m = g.mass;
    const a = [
      stress + m * C[p * 9 + 0], m * C[p * 9 + 1], m * C[p * 9 + 2],
      m * C[p * 9 + 3], stress + m * C[p * 9 + 4], m * C[p * 9 + 5],
      m * C[p * 9 + 6], m * C[p * 9 + 7], stress + m * C[p * 9 + 8],
    ];
    const vx = vel[p * 3], vy = vel[p * 3 + 1], vz = vel[p * 3 + 2];

    for (let i = 0; i < 3; i++) {
      const nx = s.base[0] + i; if (nx < 0 || nx >= g.dimX) continue;
      for (let j = 0; j < 3; j++) {
        const ny = s.base[1] + j; if (ny < 0 || ny >= g.dimY) continue;
        for (let k = 0; k < 3; k++) {
          const nz = s.base[2] + k; if (nz < 0 || nz >= g.dimZ) continue;
          const weight = s.wx[i] * s.wy[j] * s.wz[k];
          // dpos = (offset - fx) * dx  (world units)
          const dx = (i - s.fx[0]) * g.dx, dy = (j - s.fx[1]) * g.dx, dz = (k - s.fx[2]) * g.dx;
          const ax = a[0] * dx + a[1] * dy + a[2] * dz;
          const ay = a[3] * dx + a[4] * dy + a[5] * dz;
          const az = a[6] * dx + a[7] * dy + a[8] * dz;
          const node = nodeIndex(g, nx, ny, nz);
          gridMass[node] += weight * m;
          gridVel[node * 3] += weight * (m * vx + ax);
          gridVel[node * 3 + 1] += weight * (m * vy + ay);
          gridVel[node * 3 + 2] += weight * (m * vz + az);
        }
      }
    }
  }
}

/** Grid: momentum -> velocity, apply gravity and box boundary conditions. */
export function gridUpdate(g: MpmGrid, gridMass: Float32Array, gridVel: Float32Array): void {
  for (let z = 0; z < g.dimZ; z++) {
    for (let y = 0; y < g.dimY; y++) {
      for (let x = 0; x < g.dimX; x++) {
        const node = nodeIndex(g, x, y, z);
        const m = gridMass[node];
        if (m <= 0) continue;
        let vx = gridVel[node * 3] / m;
        let vy = gridVel[node * 3 + 1] / m + g.dt * g.gravity;
        let vz = gridVel[node * 3 + 2] / m;
        // sticky/separating walls: don't let velocity point out of the domain
        if (x < 2 && vx < 0) vx = 0; if (x > g.dimX - 3 && vx > 0) vx = 0;
        if (y < 2 && vy < 0) vy = 0; if (y > g.dimY - 3 && vy > 0) vy = 0;
        if (z < 2 && vz < 0) vz = 0; if (z > g.dimZ - 3 && vz > 0) vz = 0;
        gridVel[node * 3] = vx; gridVel[node * 3 + 1] = vy; gridVel[node * 3 + 2] = vz;
      }
    }
  }
}

/** Grid -> particles: gather velocity + affine (APIC), advect, update volume ratio. */
export function g2p(
  g: MpmGrid, pos: Float32Array, vel: Float32Array, C: Float32Array, J: Float32Array, n: number,
  gridVel: Float32Array,
): void {
  for (let p = 0; p < n; p++) {
    const s = stencil(g, pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]);
    let nvx = 0, nvy = 0, nvz = 0;
    const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    for (let i = 0; i < 3; i++) {
      const nx = s.base[0] + i; if (nx < 0 || nx >= g.dimX) continue;
      for (let j = 0; j < 3; j++) {
        const ny = s.base[1] + j; if (ny < 0 || ny >= g.dimY) continue;
        for (let k = 0; k < 3; k++) {
          const nz = s.base[2] + k; if (nz < 0 || nz >= g.dimZ) continue;
          const weight = s.wx[i] * s.wy[j] * s.wz[k];
          const node = nodeIndex(g, nx, ny, nz);
          const gvx = gridVel[node * 3], gvy = gridVel[node * 3 + 1], gvz = gridVel[node * 3 + 2];
          nvx += weight * gvx; nvy += weight * gvy; nvz += weight * gvz;
          // dpos in grid units (offset - fx)
          const dx = i - s.fx[0], dy = j - s.fx[1], dz = k - s.fx[2];
          const f = 4 * g.invDx * weight;
          c[0] += f * gvx * dx; c[1] += f * gvx * dy; c[2] += f * gvx * dz;
          c[3] += f * gvy * dx; c[4] += f * gvy * dy; c[5] += f * gvy * dz;
          c[6] += f * gvz * dx; c[7] += f * gvz * dy; c[8] += f * gvz * dz;
        }
      }
    }
    vel[p * 3] = nvx; vel[p * 3 + 1] = nvy; vel[p * 3 + 2] = nvz;
    for (let q = 0; q < 9; q++) C[p * 9 + q] = c[q];
    pos[p * 3] += g.dt * nvx; pos[p * 3 + 1] += g.dt * nvy; pos[p * 3 + 2] += g.dt * nvz;
    J[p] *= 1 + g.dt * (c[0] + c[4] + c[8]); // J *= 1 + dt*trace(C)
  }
}

export function mpmStep(
  g: MpmGrid, pos: Float32Array, vel: Float32Array, C: Float32Array, J: Float32Array, n: number,
  gridMass: Float32Array, gridVel: Float32Array,
): void {
  p2g(g, pos, vel, C, J, n, gridMass, gridVel);
  gridUpdate(g, gridMass, gridVel);
  g2p(g, pos, vel, C, J, n, gridVel);
}
