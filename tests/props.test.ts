import { describe, it, expect } from "vitest";
import { buildTree, buildLamppost, buildTrashCan, buildLitter } from "../src/build/prefabs";
import { findFloatingVoxels, type Voxel } from "../src/world/structuralIntegrity";
import { MATERIALS } from "../src/world/materials";

// Same Map-backed stand-in the building tests use — the prop builders only set()/markSettled() cells.
class MockGrid {
  m = new Map<string, string>();
  private k(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  set(x: number, y: number, z: number, mat: string) { this.m.set(this.k(x, y, z), mat); }
  remove(x: number, y: number, z: number) { this.m.delete(this.k(x, y, z)); }
  has(x: number, y: number, z: number) { return this.m.has(this.k(x, y, z)); }
  get(x: number, y: number, z: number) { return this.m.get(this.k(x, y, z)); }
  markSettled() {}
  markWeakBox() {}
  markIndestructibleBox() {}
  isIndestructible() { return false; }
  clear() { this.m.clear(); }
  cells(): Voxel[] {
    const out: Voxel[] = [];
    for (const key of this.m.keys()) { const [x, y, z] = key.split(",").map(Number); out.push([x, y, z]); }
    return out;
  }
}
const grounded = (g: MockGrid) => findFloatingVoxels(g.cells(), (x, y, z) => g.has(x, y, z), (_x, y) => y === 0).length;
const count = (g: MockGrid, mat: string) => { let n = 0; for (const m of g.m.values()) if (m === mat) n++; return n; };

describe("street props — destructible voxel models", () => {
  it("buildTree: every kind (oak/pine/bush) has a stem + canopy and stays grounded (nothing floats)", () => {
    for (const kind of ["oak", "pine", "bush"] as const) {
      const g = new MockGrid();
      buildTree(g as any, 10, 10, kind);
      expect(count(g, "wood")).toBeGreaterThan(0);                            // stem/trunk
      expect(count(g, "leaves") + count(g, "leaves_pine")).toBeGreaterThan(0); // canopy (broadleaf or needles)
      expect(grounded(g)).toBe(0);                                            // connects to the ground
    }
  });

  it("pine uses the dark conifer needles; oak uses broadleaf foliage", () => {
    const pine = new MockGrid(); buildTree(pine as any, 1, 1, "pine");
    expect(count(pine, "leaves_pine")).toBeGreaterThan(0);
    const oak = new MockGrid(); buildTree(oak as any, 1, 1, "oak");
    expect(count(oak, "leaves_pine")).toBe(0);
    expect(count(oak, "leaves")).toBeGreaterThan(0);
  });

  it("default kind varies by position → a mixed treeline (still deterministic)", () => {
    let pine = 0, broad = 0;
    for (let i = 0; i < 24; i++) {
      const g = new MockGrid(); buildTree(g as any, i * 7 + 1, i * 5 + 2);
      if (count(g, "leaves_pine") > 0) pine++; else broad++;
    }
    expect(pine).toBeGreaterThan(0);  // some conifers appear
    expect(broad).toBeGreaterThan(0); // …alongside broadleaf/bush
  });

  it("lamppost / trashcan / litter place voxels and sit on the ground", () => {
    for (const build of [
      (g: MockGrid) => buildLamppost(g as any, 5, 5),
      (g: MockGrid) => buildTrashCan(g as any, 5, 5),
      (g: MockGrid) => buildLitter(g as any, 5, 5),
    ]) {
      const g = new MockGrid(); build(g);
      expect(g.m.size).toBeGreaterThan(0);
      expect(grounded(g)).toBe(0);
    }
  });

  it("leaves is a weak, shattering material so trees break easily (vs a brick wall)", () => {
    expect(MATERIALS.leaves.strength).toBeLessThan(MATERIALS.brick.strength);
    expect(MATERIALS.leaves.shatters).toBe(true);
  });

  it("props are deterministic by position (multiplayer-safe)", () => {
    const a = new MockGrid(), b = new MockGrid();
    buildTree(a as any, 3, 4); buildTree(b as any, 3, 4);
    expect([...b.m.keys()].sort()).toEqual([...a.m.keys()].sort());
  });
});
