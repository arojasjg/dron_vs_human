import { describe, it, expect } from "vitest";
import { VoxelGrid, packKey, unpackKey } from "../src/world/voxelGrid";
import { MATERIALS } from "../src/world/materials";
import { VOXEL } from "../src/config";

describe("voxel key packing", () => {
  it("round-trips positive and negative coordinates", () => {
    for (const c of [[0, 0, 0], [1, 2, 3], [-5, 7, -9], [100, -100, 50]]) {
      const [x, y, z] = c;
      expect(unpackKey(packKey(x, y, z))).toEqual([x, y, z]);
    }
  });

  it("produces unique keys for distinct cells", () => {
    const keys = new Set([
      packKey(0, 0, 0), packKey(1, 0, 0), packKey(0, 1, 0), packKey(0, 0, 1), packKey(-1, 0, 0),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe("VoxelGrid", () => {
  it("set / get / remove", () => {
    const g = new VoxelGrid();
    g.set(2, 3, 4, "concrete");
    expect(g.get(2, 3, 4)).toBe("concrete");
    expect(g.has(2, 3, 4)).toBe(true);
    expect(g.remove(2, 3, 4)).toBe(true);
    expect(g.has(2, 3, 4)).toBe(false);
  });

  it("addDamage accumulates per voxel and resets when the voxel is removed", () => {
    const g = new VoxelGrid();
    g.set(1, 1, 1, "concrete");
    expect(g.addDamage(1, 1, 1)).toBe(1);
    expect(g.addDamage(1, 1, 1)).toBe(2);
    g.remove(1, 1, 1);
    expect(g.addDamage(1, 1, 1)).toBe(1);
  });

  it("a voxel breaks after exactly hp bullet hits (glass=1 … metal=5)", () => {
    const g = new VoxelGrid();
    for (const id of ["glass", "wood", "brick", "concrete", "metal"] as const) {
      g.set(0, 0, 0, id);
      const hp = MATERIALS[id].hp;
      let hits = 0;
      while (g.addDamage(0, 0, 0) < hp) hits++;
      hits++; // the hit that reached hp and broke it
      expect(hits).toBe(hp);
      g.remove(0, 0, 0); // clears damage for the next material
    }
  });

  it("worldToVoxel maps world space to integer cells", () => {
    expect(VoxelGrid.worldToVoxel(0.1, 0.1, 0.1)).toEqual([0, 0, 0]);
    expect(VoxelGrid.worldToVoxel(VOXEL * 1.5, VOXEL * 2.5, 0)).toEqual([1, 2, 0]);
  });

  it("raycast returns the exact voxel and a face normal pointing back at the ray", () => {
    const g = new VoxelGrid();
    g.set(10, 0, 0, "brick");
    // fire from origin along +x through the middle of row y=0,z=0
    const hit = g.raycast(0, VOXEL * 0.5, VOXEL * 0.5, 1, 0, 0, 1000);
    expect(hit).not.toBeNull();
    expect([hit!.vx, hit!.vy, hit!.vz]).toEqual([10, 0, 0]);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(hit!.material).toBe("brick");
  });

  it("raycast returns null when nothing is hit within range", () => {
    const g = new VoxelGrid();
    g.set(100, 0, 0, "wood");
    expect(g.raycast(0, VOXEL * 0.5, VOXEL * 0.5, 1, 0, 0, 5)).toBeNull();
  });
});
