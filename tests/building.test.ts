import { describe, it, expect } from "vitest";
import { BIG, buildBuilding, buildDefaultScene, placedBuildings, setWorldSeed, stairShaft } from "../src/build/prefabs";
import { findFloatingVoxels, type Voxel } from "../src/world/structuralIntegrity";

// Minimal stand-in for VoxelGrid — buildBuilding only ever set()/remove()s cells.
class MockGrid {
  m = new Map<string, string>();
  private k(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  set(x: number, y: number, z: number, mat: string) { this.m.set(this.k(x, y, z), mat); }
  remove(x: number, y: number, z: number) { this.m.delete(this.k(x, y, z)); }
  has(x: number, y: number, z: number) { return this.m.has(this.k(x, y, z)); }
  get(x: number, y: number, z: number) { return this.m.get(this.k(x, y, z)); }
  markSettled() {}
  markWeakBox() {}
  clear() { this.m.clear(); }
  cells(): Voxel[] {
    const out: Voxel[] = [];
    for (const key of this.m.keys()) { const [x, y, z] = key.split(",").map(Number); out.push([x, y, z]); }
    return out;
  }
}

const COL = 14, STRIDE = BIG.H + 1;
const TOP_Y = BIG.FLOORS * STRIDE;
const build = (seed = 1) => {
  const g = new MockGrid();
  setWorldSeed(seed);
  buildBuilding(g as unknown as Parameters<typeof buildBuilding>[0], 0, 0);
  return g;
};

describe("buildBuilding — structure & variety", () => {
  it("keeps the column grid solid concrete from the ground to the roof", () => {
    const g = build();
    for (const cx of [COL, 4 * COL, 10 * COL])
      for (const cz of [COL, 5 * COL])
        for (const y of [0, STRIDE, 3 * STRIDE, TOP_Y])
          expect(g.get(cx, y, cz)).toBe("concrete");
  });

  it("cuts sparse windows: small glass panes plus at least one drone-sized open gap", () => {
    const g = build(1);
    let glass = 0, widestOpen = 0;
    for (let s = 1; s < BIG.FLOORS; s++) {         // upper floors only (skip ground-floor entrances)
      const base = s * STRIDE;
      for (let yy = base + 3; yy <= base + 6; yy++) {
        let run = 0;
        for (let x = 1; x < BIG.W - 1; x++) {
          if (g.get(x, yy, 0) === "glass") glass++;
          run = g.has(x, yy, 0) ? 0 : run + 1;     // contiguous open run along the front facade
          widestOpen = Math.max(widestOpen, run);
        }
      }
    }
    expect(glass).toBeGreaterThan(0);              // small glass panes exist
    expect(widestOpen).toBeGreaterThanOrEqual(5);  // ≥1 opening wide enough for a drone to fly through
  });

  it("never puts an interior partition wall off the column grid", () => {
    const g = build();
    const y = STRIDE + 12; // floor 1, above the doorway lintels
    // points whose x AND z are both off every column line can only be open room air —
    // partition walls live exclusively on the column lines.
    for (const x of [45, 73, 101, 157])
      for (const z of [45, 59, 101, 129])
        expect(g.has(x, y, z)).toBe(false);
  });

  it("switch-back: consecutive flights sit in DIFFERENT lanes, joined by a full-width landing (no dead-end stacking)", () => {
    const g = build();
    const sh = stairShaft(0, 0);
    const laneAmid = sh.x0 + 1, laneBmid = sh.x1 - 1; // centres of the west/east lanes
    for (let s = 0; s + 1 < BIG.FLOORS; s++) {
      const floorY = (s + 1) * STRIDE;               // where flight s ends AND flight s+1 begins
      const landE = s % 2 === 0 ? sh.z1 : sh.z0;      // the switch-back z-end
      // a full-width landing spans BOTH lanes at the join, so you can walk across and turn
      expect(g.has(laneAmid, floorY, landE)).toBe(true);
      expect(g.has(laneBmid, floorY, landE)).toBe(true);
      // the NEXT flight rises in the OTHER lane (not stacked directly over this flight's top)
      const nextLaneMid = (s + 1) % 2 === 0 ? laneAmid : laneBmid;
      expect(g.has(nextLaneMid, floorY + 1, landE)).toBe(true); // next flight's first step is here
    }
  });

  it("produces at least one double-height (two-storey) room", () => {
    const g = build();
    let tallest = 0;
    // sample off the column grid (columns sit on every 14-voxel line)
    for (let s = 1; s + 1 < BIG.FLOORS; s++) {
      const base = s * STRIDE;
      for (let x = 33; x < BIG.W - 4; x += 28)
        for (let z = 33; z < BIG.D - 4; z += 28) {
          let h = 0;
          for (let y = base + 1; y < base + 2 * STRIDE; y++) { if (!g.has(x, y, z)) h++; else break; }
          if (h > tallest) tallest = h;
        }
    }
    expect(tallest).toBeGreaterThan(STRIDE + 4); // clearly taller than a single storey
  });

  it("builds one grounded mass — nothing floats", () => {
    const g = build();
    const floating = findFloatingVoxels(g.cells(), (x, y, z) => g.has(x, y, z), (_x, y) => y === 0);
    expect(floating.length).toBe(0);
  });

  it("generates deterministically for a given seed (multiplayer-safe)", () => {
    const a = build(7), b = build(7);
    expect(b.m.size).toBe(a.m.size);
    for (const [x, y, z] of [[42, 25, 42], [140, 60, 100], [70, 90, 130], [200, 40, 50]] as const)
      expect(b.get(x, y, z)).toBe(a.get(x, y, z));
  });
});

describe("buildDefaultScene — varied city block", () => {
  const scene = (seed: number) => {
    const g = new MockGrid();
    setWorldSeed(seed);
    buildDefaultScene(g as unknown as Parameters<typeof buildDefaultScene>[0]);
    return g;
  };
  const PLOT_W = Math.floor(BIG.W / 6), PLOT_D = Math.floor(BIG.D / 5);

  it("places many small buildings with at least one taller landmark", () => {
    const g = scene(3);
    const b = placedBuildings();
    expect(b.length).toBe(30);                                              // 6×5 plots → more buildings
    expect(Math.max(...b.map((p) => p.FLOORS))).toBeGreaterThanOrEqual(5);  // a taller landmark exists
    expect(Math.min(...b.map((p) => p.FLOORS))).toBeLessThanOrEqual(3);     // the majority are low
    expect(new Set(b.map((p) => p.W)).size).toBeGreaterThan(3);             // varied (randomised) footprints
    // every building sits on the ground at its own centre
    for (const p of b) expect(g.has(p.ox + (p.W >> 1), 0, p.oz + (p.D >> 1))).toBe(true);
  });

  it("leaves streets (gaps) between the buildings", () => {
    const g = scene(3);
    for (const px of [1, 2, 3, 4, 5]) expect(g.has(px * PLOT_W, 0, Math.floor(PLOT_D / 2))).toBe(false);
  });

  it("generates the identical block for a given seed (multiplayer-safe)", () => {
    const a = scene(9), b = scene(9);
    expect(b.m.size).toBe(a.m.size);
  });

  it("builds a grounded block — nothing floats", () => {
    const g = scene(3);
    const floating = findFloatingVoxels(g.cells(), (x, y, z) => g.has(x, y, z), (_x, y) => y === 0);
    expect(floating.length).toBe(0);
  });
});

describe("building entrances", () => {
  // count maximal empty runs (>=2 wide) along a wall line at y=2 (below the windows, so only
  // real doorways read as empty)
  const runs = (n: number, empty: (i: number) => boolean) => {
    let c = 0, r = 0;
    for (let i = 0; i < n; i++) { if (empty(i)) r++; else { if (r >= 2) c++; r = 0; } }
    return c + (r >= 2 ? 1 : 0);
  };
  const countEntrances = (g: MockGrid, W: number, D: number) => {
    const y = 2;
    return runs(W - 2, (i) => !g.has(1 + i, y, 0))       // front
      + runs(W - 2, (i) => !g.has(1 + i, y, D - 1))      // back
      + runs(D - 2, (i) => !g.has(0, y, 1 + i))          // left
      + runs(D - 2, (i) => !g.has(W - 1, y, 1 + i));     // right
  };

  for (const [W, D, F] of [[48, 48, 3], [56, 44, 4], [60, 52, 3], [72, 60, 5]] as const) {
    it(`W${W} D${D}: has 2–3 exterior entrances`, () => {
      const g = new MockGrid();
      setWorldSeed(5);
      buildBuilding(g as unknown as Parameters<typeof buildBuilding>[0], 0, 0, { W, D, FLOORS: F });
      const n = countEntrances(g, W, D);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    });
  }
});

describe("stairs reach the roof", () => {
  const small = (W: number, D: number, FLOORS: number) => {
    const g = new MockGrid();
    setWorldSeed(1);
    buildBuilding(g as unknown as Parameters<typeof buildBuilding>[0], 0, 0, { W, D, FLOORS });
    return { g, FLOORS };
  };
  const sh = stairShaft(0, 0);
  const xMid = sh.x0 + 2;

  for (const [W, D, F] of [[48, 48, 3], [56, 44, 4], [64, 60, 5]] as const) {
    it(`W${W} D${D} F${F}: the top flight lands on a full-width roof landing (climbable to the rooftop)`, () => {
      const { g } = small(W, D, F);
      const roofY = F * STRIDE;
      const topEven = (F - 1) % 2 === 0;            // lane/direction of the TOP flight (s=F-1)
      const laneMid = topEven ? sh.x0 + 1 : sh.x1 - 1;
      const landE = topEven ? sh.z1 : sh.z0;        // z-end where it finishes = roof landing
      expect(g.has(laneMid, roofY - 1, landE)).toBe(true);   // top step reaches just under the roof
      expect(g.has(xMid, roofY, landE)).toBe(true);          // full-width landing to step onto the roof
      expect(g.has(xMid, roofY, sh.z0 + 8)).toBe(false);     // roof HOLED over the flight (open shaft)
      expect(g.has(Math.floor(W / 2), roofY, Math.floor(D / 2))).toBe(true); // roof exists elsewhere
    });
  }
});
