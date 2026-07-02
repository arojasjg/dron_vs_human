import { describe, it, expect } from "vitest";
import { p2g, g2p, mpmStep, mpmNumNodes, type MpmGrid } from "../src/gpu/cpu/mpm";

const grid = (over: Partial<MpmGrid> = {}): MpmGrid => ({
  dx: 1, invDx: 1, ox: 0, oy: 0, oz: 0, dimX: 16, dimY: 16, dimZ: 16,
  dt: 0.002, gravity: -9.8, mass: 1, vol: 1, E: 50, ...over,
});

function buffers(g: MpmGrid) {
  const nn = mpmNumNodes(g);
  return { gridMass: new Float32Array(nn), gridVel: new Float32Array(nn * 3) };
}

describe("MLS-MPM (CPU twin)", () => {
  it("P2G conserves mass (weights are a partition of unity)", () => {
    const g = grid();
    const n = 50;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), C = new Float32Array(n * 9), J = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) { pos[i * 3] = 6 + Math.random() * 4; pos[i * 3 + 1] = 6 + Math.random() * 4; pos[i * 3 + 2] = 6 + Math.random() * 4; }
    const { gridMass, gridVel } = buffers(g);
    p2g(g, pos, vel, C, J, n, gridMass, gridVel);
    let total = 0; for (let i = 0; i < gridMass.length; i++) total += gridMass[i];
    expect(total).toBeCloseTo(n * g.mass, 3);
  });

  it("P2G conserves momentum when stress-free (J=1, C=0)", () => {
    const g = grid();
    const n = 40;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), C = new Float32Array(n * 9), J = new Float32Array(n).fill(1);
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = 6 + Math.random() * 4; pos[i * 3 + 1] = 6 + Math.random() * 4; pos[i * 3 + 2] = 6 + Math.random() * 4;
      vel[i * 3] = Math.random() - 0.5; vel[i * 3 + 1] = Math.random() - 0.5; vel[i * 3 + 2] = Math.random() - 0.5;
      px += g.mass * vel[i * 3]; py += g.mass * vel[i * 3 + 1]; pz += g.mass * vel[i * 3 + 2];
    }
    const { gridMass, gridVel } = buffers(g);
    p2g(g, pos, vel, C, J, n, gridMass, gridVel);
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < gridMass.length; i++) { gx += gridVel[i * 3]; gy += gridVel[i * 3 + 1]; gz += gridVel[i * 3 + 2]; }
    expect(gx).toBeCloseTo(px, 3); expect(gy).toBeCloseTo(py, 3); expect(gz).toBeCloseTo(pz, 3);
  });

  it("G2P of a uniform grid velocity gives that velocity and zero affine", () => {
    const g = grid();
    const n = 20;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), C = new Float32Array(n * 9), J = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) { pos[i * 3] = 6 + Math.random() * 4; pos[i * 3 + 1] = 6 + Math.random() * 4; pos[i * 3 + 2] = 6 + Math.random() * 4; }
    const { gridVel } = buffers(g);
    const V = [2, -1, 3];
    for (let i = 0; i < gridVel.length / 3; i++) { gridVel[i * 3] = V[0]; gridVel[i * 3 + 1] = V[1]; gridVel[i * 3 + 2] = V[2]; }
    g2p(g, pos, vel, C, J, n, gridVel);
    for (let i = 0; i < n; i++) {
      expect(vel[i * 3]).toBeCloseTo(V[0], 4); expect(vel[i * 3 + 1]).toBeCloseTo(V[1], 4); expect(vel[i * 3 + 2]).toBeCloseTo(V[2], 4);
      for (let q = 0; q < 9; q++) expect(Math.abs(C[i * 9 + q])).toBeLessThan(1e-4); // uniform field -> no affine
    }
  });

  it("a fluid block falls and stays bounded (no NaN/explosion)", () => {
    const g = grid();
    const pts: number[] = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) pts.push(5 + x * 0.5, 9 + y * 0.5, 5 + z * 0.5);
    const n = pts.length / 3;
    const pos = new Float32Array(pts), vel = new Float32Array(n * 3), C = new Float32Array(n * 9), J = new Float32Array(n).fill(1);
    const { gridMass, gridVel } = buffers(g);

    let avgYStart = 0; for (let i = 0; i < n; i++) avgYStart += pos[i * 3 + 1]; avgYStart /= n;
    for (let s = 0; s < 120; s++) mpmStep(g, pos, vel, C, J, n, gridMass, gridVel);

    let avgY = 0, ok = true;
    for (let i = 0; i < n * 3; i++) if (!Number.isFinite(pos[i])) ok = false;
    for (let i = 0; i < n; i++) {
      avgY += pos[i * 3 + 1];
      for (let d = 0; d < 3; d++) { const v = pos[i * 3 + d]; if (v < 0 || v > 16) ok = false; }
    }
    avgY /= n;
    expect(ok).toBe(true);          // stable + inside the domain
    expect(avgY).toBeLessThan(avgYStart); // it fell under gravity
  });
});
