import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { Physics } from "../src/engine/physics";
import { DebrisSystem } from "../src/destruction/debris";
import { explode } from "../src/destruction/explosion";
import { VoxelGrid } from "../src/world/voxelGrid";
import { MATERIAL_ORDER } from "../src/world/materials";
import { buildDefaultScene, setWorldSeed } from "../src/build/prefabs";
import { eventSeed, EVT, q2 } from "../src/engine/rng";
import { FIXED_DT } from "../src/config";

beforeAll(async () => { await RAPIER.init(); });

// A self-contained deterministic sim built from the SAME production code the game runs: a real Rapier
// world, the real DebrisSystem, the real seeded `explode()`. A null particle sink keeps cosmetic
// randomness (CPU particles) out of the measurement entirely. debris.cap stays at its constant default
// (no perf governor here), which is exactly the input-independent condition lockstep needs.
function makeSim(roomSeed: number) {
  const physics = new Physics();
  const scene = new THREE.Scene();
  const debris = new DebrisSystem(physics, scene);
  const grid = new VoxelGrid();
  setWorldSeed(roomSeed);
  buildDefaultScene(grid);
  const targets = { grid, debris, particles: { burst() {} } } as unknown as Parameters<typeof explode>[1];
  let time = 0;
  let debrisSpawned = 0;
  return {
    grid, debris,
    get debrisSpawned() { return debrisSpawned; },
    explode(x: number, y: number, z: number, r: number, p: number) {
      // Quantize at source exactly like game.ts explodeAt, then derive the per-event seed from the wire values.
      const qx = q2(x) / 100, qy = q2(y) / 100, qz = q2(z) / 100, qr = q2(r) / 100;
      const seed = eventSeed(roomSeed, EVT.EXPLODE, q2(qx), q2(qy), q2(qz), q2(qr), p | 0);
      explode(physics, targets, qx, qy, qz, qr, p, seed);
      debrisSpawned = Math.max(debrisSpawned, debris.count);
    },
    step() { physics.step(time); time += FIXED_DT; debris.update(FIXED_DT); },
    initialCells: grid.cells.size,
  };
}

type Sim = ReturnType<typeof makeSim>;

// FNV-1a over a CANONICAL byte order: grid keys sorted numerically (+material index), then the debris
// transforms sorted lexicographically and rounded — so the hash depends on STATE, never on Map/array order.
function hash(sim: Sim, includeDebris = true): number {
  let h = 0x811c9dc5 >>> 0;
  const mix = (v: number) => { h ^= v | 0; h = Math.imul(h, 0x01000193); };
  const keys = [...sim.grid.cells.keys()].sort((a, b) => a - b);
  mix(keys.length);
  for (const k of keys) { mix(k); mix(MATERIAL_ORDER.indexOf(sim.grid.cells.get(k)!)); }
  if (includeDebris) {
    const rows = sim.debris.snapshot().map((d) => [
      MATERIAL_ORDER.indexOf(d.material),
      Math.round(d.x * 1e5), Math.round(d.y * 1e5), Math.round(d.z * 1e5),
      Math.round(d.qx * 1e5), Math.round(d.qy * 1e5), Math.round(d.qz * 1e5), Math.round(d.qw * 1e5),
    ]);
    rows.sort((a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
    mix(rows.length);
    for (const r of rows) for (const v of r) mix(v);
  }
  return h >>> 0;
}

// A fixed scripted event+step sequence (blasts into the city, then fly/settle the debris).
function runScript(sim: Sim) {
  sim.explode(2, 1, 2, 2.4, 520);
  for (let i = 0; i < 20; i++) sim.step();
  sim.explode(4, 1.5, 3, 3.0, 900);
  for (let i = 0; i < 40; i++) sim.step();
}

describe("M0 — deterministic destruction core (divergence hash)", () => {
  it("two independent sims, same seed + same events → BYTE-IDENTICAL grid+debris", () => {
    const a = makeSim(1234); const b = makeSim(1234);
    runScript(a); runScript(b);
    // the scenario is non-trivial (it actually carved and threw debris)
    expect(a.grid.cells.size).toBeLessThan(a.initialCells);
    expect(a.debrisSpawned).toBeGreaterThan(0);
    // and both worlds match exactly — grid AND live debris transforms
    expect(hash(b)).toBe(hash(a));
  });

  it("replay identity: same script in a fresh sim reproduces the same hash", () => {
    const a = makeSim(777); runScript(a);
    const b = makeSim(777); runScript(b);
    expect(hash(b)).toBe(hash(a));
  });

  it("NEGATIVE control: a different room seed → different world (guards a degenerate hash)", () => {
    const a = makeSim(1234); runScript(a);
    const b = makeSim(9999); runScript(b);
    expect(hash(b)).not.toBe(hash(a));
  });

  it("NEGATIVE control: one extra blast in B → different hash (the hash reflects inputs)", () => {
    const a = makeSim(42); runScript(a);
    const b = makeSim(42); runScript(b); b.explode(6, 1, 5, 2.0, 600); for (let i = 0; i < 10; i++) b.step();
    expect(hash(b)).not.toBe(hash(a));
  });

  it("order-robustness: two blasts applied in OPPOSITE order → the GRID still converges", () => {
    // per-event seeds are payload-derived, so grid destruction is order-independent (debris transients
    // legitimately differ mid-flight, so the grid-only hash is the invariant that must hold).
    const a = makeSim(55); a.explode(2, 1, 2, 2.4, 520); for (let i = 0; i < 5; i++) a.step(); a.explode(4, 1.5, 3, 3.0, 900);
    const b = makeSim(55); b.explode(4, 1.5, 3, 3.0, 900); for (let i = 0; i < 5; i++) b.step(); b.explode(2, 1, 2, 2.4, 520);
    for (let i = 0; i < 60; i++) { a.step(); b.step(); }
    expect(hash(b, false)).toBe(hash(a, false)); // grid-only: same voxels removed regardless of order
  });
});
