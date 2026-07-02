import { describe, it, expect } from "vitest";
import { buildDefaultScene, setWorldSeed } from "../src/build/prefabs";
import { carveSphere } from "../src/destruction/carve";

// Two "clients" are simulated as two independent grids. The multiplayer sync contract is:
// same seed (identical world) + same sequence of authoritative blast events ⇒ byte-identical
// worlds on every machine. This test is that contract as a failable check.
class MockGrid {
  m = new Map<string, string>();
  private k(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  set(x: number, y: number, z: number, mat: string) { this.m.set(this.k(x, y, z), mat); }
  remove(x: number, y: number, z: number) { this.m.delete(this.k(x, y, z)); }
  has(x: number, y: number, z: number) { return this.m.has(this.k(x, y, z)); }
  get(x: number, y: number, z: number) { return this.m.get(this.k(x, y, z)); }
  markSettled() {}
  clear() { this.m.clear(); }
  /** Order-independent checksum of the whole voxel set (commutative sum of per-cell hashes). */
  hash(): number {
    let h = 0;
    for (const [key, mat] of this.m) {
      let s = 2166136261;
      const str = key + ":" + mat;
      for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619); }
      h = (h + (s >>> 0)) >>> 0;
    }
    return h;
  }
}

// A fixed, authoritative event stream (world-space blasts) applied to both clients identically.
const BLASTS: [number, number, number, number][] = [
  [5, 1, 5, 1.6], [12, 3, 9, 2.2], [18, 2, 16, 2.6], [8, 5, 22, 2.0], [26, 4, 12, 3.0], [3, 2, 40, 1.8],
];

function client(seed: number): MockGrid {
  const grid = new MockGrid();
  const targets = { grid, debris: { spawn: () => false }, particles: { burst: () => {} } };
  setWorldSeed(seed);
  buildDefaultScene(grid as never);
  for (const [x, y, z, r] of BLASTS)
    carveSphere(targets as never, x, y, z, r, 600, 8);
  return grid;
}

describe("multiplayer world determinism", () => {
  it("same seed + same blast events → byte-identical world on both clients", () => {
    const a = client(1234), b = client(1234);
    expect(b.m.size).toBe(a.m.size);
    expect(b.hash()).toBe(a.hash());
    expect(a.m.size).toBeGreaterThan(1000); // sanity: it actually built and carved something
  });

  it("a different room seed produces a different world (the seed genuinely drives it)", () => {
    expect(client(1234).hash()).not.toBe(client(9999).hash());
  });
});
