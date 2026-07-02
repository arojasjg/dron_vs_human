import { describe, it, expect } from "vitest";
import { PerfGovernor } from "../src/engine/perfGovernor";
import { buildBuilding, buildDefaultScene, setWorldSeed } from "../src/build/prefabs";
import { carveSphere } from "../src/destruction/carve";
import { findUnsupported, type Voxel } from "../src/world/structuralIntegrity";
import { STRUCTURE_MAX_OVERHANG } from "../src/config";

class MockGrid {
  m = new Map<string, string>();
  private k(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  set(x: number, y: number, z: number, mat: string) { this.m.set(this.k(x, y, z), mat); }
  remove(x: number, y: number, z: number) { this.m.delete(this.k(x, y, z)); }
  has(x: number, y: number, z: number) { return this.m.has(this.k(x, y, z)); }
  get(x: number, y: number, z: number) { return this.m.get(this.k(x, y, z)); }
  markSettled() {}
  clear() { this.m.clear(); }
  cells(): Voxel[] {
    const out: Voxel[] = [];
    for (const key of this.m.keys()) { const [x, y, z] = key.split(",").map(Number); out.push([x, y, z]); }
    return out;
  }
  hash(): number {
    let h = 0;
    for (const [key, mat] of this.m) {
      let s = 2166136261; const str = key + ":" + mat;
      for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619); }
      h = (h + (s >>> 0)) >>> 0;
    }
    return h;
  }
}

const STUB = { debris: { spawn: () => false }, particles: { burst: () => {} } };
// a fixed "detonation storm" (world-space blasts) — deterministic so both runs match
const STORM: [number, number, number, number][] = Array.from({ length: 40 }, (_, i) =>
  [(i * 7) % 68 + 3, (i % 6) * 4 + 2, (i * 11) % 50 + 3, 2.0 + (i % 3) * 0.6]);

describe("perf: the governor throttles the whole spectacle under load", () => {
  it("cuts the shared budget (debris cap + GPU particle emission) hard and fast, then recovers", () => {
    const g = new PerfGovernor();
    let budget = 1;
    for (let i = 0; i < 20; i++) budget = g.update(25); // sustained low FPS
    expect(budget).toBeLessThanOrEqual(0.4); // ≤40% debris AND ≤40% particles emitted
    expect(budget).toBeGreaterThanOrEqual(0.2); // never collapses to nothing
    for (let i = 0; i < 300; i++) budget = g.update(60); // headroom returns
    expect(budget).toBeCloseTo(1, 5);
  });
});

describe("perf: destruction handles a storm at scale", () => {
  const runStorm = (): { grid: MockGrid; removed: number } => {
    const grid = new MockGrid();
    setWorldSeed(2024);
    buildDefaultScene(grid as never);
    let removed = 0;
    for (const [x, y, z, r] of STORM) removed += carveSphere({ grid, ...STUB } as never, x, y, z, r, 600, 8).removed;
    return { grid, removed };
  };

  it("40 simultaneous blasts across the city block carve a lot, and stay deterministic", () => {
    const a = runStorm(), b = runStorm();
    expect(a.removed).toBeGreaterThan(3000);   // real, heavy destruction happened
    expect(b.grid.hash()).toBe(a.grid.hash()); // identical on every client despite the storm
  });

  it("the support solver converges (terminates) after heavy damage — no runaway", () => {
    const grid = new MockGrid();
    setWorldSeed(7);
    buildBuilding(grid as never, 0, 0, { W: 56, D: 56, FLOORS: 3 }); // a small building keeps the pass fast
    for (let i = 0; i < 12; i++) carveSphere({ grid, ...STUB } as never, (i * 3) % 12 + 2, (i % 4) * 3 + 2, (i * 5) % 12 + 2, 2.2, 600, 8);
    let passes = 0;
    for (; passes < 60; passes++) {
      const fall = findUnsupported(grid.cells(), (x, y, z) => grid.has(x, y, z), (_x, y) => y === 0, STRUCTURE_MAX_OVERHANG);
      if (fall.length === 0) break;
      for (const [x, y, z] of fall) grid.remove(x, y, z);
    }
    expect(passes).toBeLessThan(60); // it settled instead of oscillating forever
    expect(findUnsupported(grid.cells(), (x, y, z) => grid.has(x, y, z), (_x, y) => y === 0, STRUCTURE_MAX_OVERHANG).length).toBe(0);
  });
});
