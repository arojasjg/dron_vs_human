import { describe, it, expect } from "vitest";
import { AiSwarm, type AiTarget, type AiNoise, type AiDrop, type AiBoom, type AiBreak } from "../src/net/ai";
import { VoxelGrid, unpackKey } from "../src/world/voxelGrid";
import { buildDefaultScene, setWorldSeed } from "../src/build/prefabs";
import { cookMeshChunk, MESH_CHUNK } from "../src/world/cook";
import { carveSphere } from "../src/destruction/carve";
import { MATERIAL_ORDER } from "../src/world/materials";

// ────────────────────────────────────────────────────────────────────────────
// DIVERGENCE HARNESS (golden-master). The existing determinism.test asserts two
// sims AGREE with each other — it passes even if a change shifts the output, as
// long as it shifts identically in both. This file pins the EXACT baseline hash
// of each deterministic subsystem, so ANY change that alters the bit-level output
// (an accidental FP reorder, a gate flip, a cook box change) fails immediately.
// Golden values captured from baseline commit 10eeef6. Bit-exact FNV-1a over the
// raw IEEE-754 bytes of every field (round-free → catches sub-ulp drift too).
// ────────────────────────────────────────────────────────────────────────────

const _ab = new ArrayBuffer(8), _f = new Float64Array(_ab), _u = new Uint32Array(_ab);
const FNV = 0x811c9dc5 >>> 0;
function mixI(h: number, v: number): number { return (Math.imul(h ^ (v | 0), 0x01000193)) >>> 0; }
function mixF(h: number, v: number): number { _f[0] = v; h = (Math.imul(h ^ _u[0], 0x01000193)) >>> 0; return (Math.imul(h ^ _u[1], 0x01000193)) >>> 0; }

/** A small deterministic PRNG so the harness never touches Math.random. */
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Drive the host AI sim through a fixed, fully-deterministic scenario and hash every bot field + every
 *  emitted event, each frame. Exercises: spatial hash/separation, support heal, belief/orbit/ring math,
 *  multi-target threat pick, wall→openingSeek, height/collision march, firing. */
function aiGolden(): number {
  const s = new AiSwarm();
  const rng = mulberry32(0x1234);
  s.spawnWave(45, 0, 45, 15, rng);    // wave 0 — base trio, clustered (drives separation)
  s.spawnWave(-35, 0, 25, 25, rng);   // wave 1
  s.spawnWave(10, 0, -40, 30, rng);   // wave 2 — kamikazes phase in
  s.spawnWave(-20, 0, -15, 30, rng);  // wave 3 — tanks
  s.spawnWave(30, 0, 30, 30, rng);    // wave 4 — supports (heal path)
  const aim = mulberry32(0x9999);
  const solid = (x: number, _y: number, z: number): boolean => { const fx = Math.floor(x), fz = Math.floor(z); return fx === 12 && fz >= -8 && fz <= 8; }; // a fixed wall → wallAhead/openingSeek
  const los = (bx: number, _by: number, _bz: number, _tx: number, _ty: number, tz: number): boolean => ((((Math.floor(bx) + Math.floor(tz)) % 4) + 4) % 4) !== 0; // deterministic partial sight
  const noises: AiNoise[] = [{ x: 6, z: 6, loud: 25 }, { x: -20, z: 10, loud: 15 }];
  const drops: AiDrop[] = [], booms: AiBoom[] = [], breaks: AiBreak[] = [];
  let h = FNV;
  for (let f = 0; f < 300; f++) {
    const targets: AiTarget[] = [
      { id: 1, x: Math.sin(f * 0.05) * 10, y: 1, z: Math.cos(f * 0.05) * 8, vx: Math.cos(f * 0.05) * 2, vz: -Math.sin(f * 0.05) * 2, aimX: 1, aimZ: 0, hp: 100, maxHp: 150, firing: f % 3 === 0 },
      { id: 2, x: 20, y: 0, z: -12 },
    ];
    drops.length = 0; booms.length = 0; breaks.length = 0;
    const fires = s.tick(1 / 30, targets, los, aim, drops, booms, solid, noises, breaks);
    for (const b of s.list) {
      h = mixI(h, b.id); h = mixF(h, b.x); h = mixF(h, b.y); h = mixF(h, b.z); h = mixF(h, b.hp); h = mixF(h, b.cd); h = mixF(h, b.gcd);
      h = mixF(h, b.lsx); h = mixF(h, b.lsz); h = mixF(h, b.lsT); h = mixF(h, b.ba); h = mixI(h, b.bt);
      h = mixF(h, b.fx); h = mixF(h, b.fz); h = mixF(h, b.okx); h = mixF(h, b.okz); h = mixF(h, b.oky); h = mixF(h, b.okT); h = mixF(h, b.stun);
    }
    h = mixI(h, fires.length); for (const fr of fires) { h = mixI(h, fr.id); h = mixF(h, fr.dx); h = mixF(h, fr.dy); h = mixF(h, fr.dz); h = mixI(h, fr.targetId); h = mixI(h, fr.blind ? 1 : 0); }
    h = mixI(h, drops.length); for (const d of drops) { h = mixI(h, d.id); h = mixF(h, d.x); h = mixF(h, d.y); h = mixF(h, d.z); }
    h = mixI(h, booms.length); for (const bo of booms) { h = mixI(h, bo.id); h = mixF(h, bo.x); }
    h = mixI(h, breaks.length); for (const bk of breaks) { h = mixI(h, bk.id); h = mixF(h, bk.dx); h = mixF(h, bk.dz); }
  }
  return h;
}

/** Cook a fixed mesh chunk of a seeded city and hash the greedy boxes' matrices + weathering colours. */
function cookGolden(): number {
  setWorldSeed(4242); const grid = new VoxelGrid(); buildDefaultScene(grid);
  const keys: number[] = [], matIdx: number[] = [];
  for (const k of grid.keys()) {
    const [x, y, z] = unpackKey(k);
    if (x >= 0 && x < MESH_CHUNK && y >= 0 && y < MESH_CHUNK && z >= 0 && z < MESH_CHUNK) { keys.push(k); matIdx.push(MATERIAL_ORDER.indexOf(grid.materialAt(k)!)); }
  }
  const parts = cookMeshChunk(keys, matIdx);
  let h = mixI(FNV, parts.length);
  for (const p of parts) { h = mixI(h, p.matIdx); h = mixI(h, p.matrices.length); for (let i = 0; i < p.matrices.length; i++) h = mixF(h, p.matrices[i]); for (let i = 0; i < p.colors.length; i++) h = mixF(h, p.colors[i]); }
  return h;
}

/** Carve a fixed blast sequence into a seeded city (grid only, RAPIER-free) and hash the surviving voxels. */
function carveGolden(): number {
  setWorldSeed(1234); const grid = new VoxelGrid(); buildDefaultScene(grid);
  const t = { grid, debris: { spawn: () => false }, particles: { burst: () => {} } } as unknown as Parameters<typeof carveSphere>[0];
  const blasts: [number, number, number, number, number][] = [[2, 1, 2, 2.4, 520], [4, 1.5, 3, 3.0, 900], [10, 2, 10, 2.0, 600], [-5, 1, 8, 2.8, 750], [7, 3, 14, 3.2, 1000]];
  for (const [x, y, z, r, e] of blasts) carveSphere(t, x, y, z, r, e, 8, 1);
  const keys = [...grid.keys()].sort((a, b) => a - b);
  let h = mixI(FNV, keys.length);
  for (const k of keys) { h = mixI(h, k); h = mixI(h, MATERIAL_ORDER.indexOf(grid.materialAt(k)!)); }
  return h;
}

// Golden baselines — captured from commit 10eeef6 (pre-optimization). See header.
// GOLD_AI re-baselined after the DELIBERATE building-entry behaviour rework (bots drop to the door/window band
// and enter instead of climbing onto the roof), then again after the DELIBERATE sight-acquisition delay (CBT-M5:
// a bot must hold LOS for acquireDelay before its FIRST shot), then again for CBT-M7 (spawn positions jittered off
// the perfect even ring — ONLY x/z moved; cd/gcd/seed/orbit and the rng stream are byte-identical, proven).
// Cook/carve are pure optimizations → never moved.
const GOLD_AI = 306083037;
const GOLD_COOK = 3326779269;
const GOLD_CARVE = 683759392;

describe("divergence harness — deterministic subsystems are BIT-IDENTICAL to baseline", () => {
  it("is self-consistent (same code, two runs → same hash) and non-degenerate", () => {
    expect(aiGolden()).toBe(aiGolden());
    expect(cookGolden()).toBe(cookGolden());
    expect(carveGolden()).toBe(carveGolden());
    expect(aiGolden()).not.toBe(0); expect(cookGolden()).not.toBe(0); expect(carveGolden()).not.toBe(0);
  });

  it("AI swarm sim matches the golden baseline hash", () => { expect(aiGolden() >>> 0).toBe(GOLD_AI); });
  it("mesh cook matches the golden baseline hash", () => { expect(cookGolden() >>> 0).toBe(GOLD_COOK); });
  it("voxel carve matches the golden baseline hash", () => { expect(carveGolden() >>> 0).toBe(GOLD_CARVE); });
});
