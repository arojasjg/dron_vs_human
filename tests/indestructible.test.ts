import { describe, it, expect } from "vitest";
import { VoxelGrid } from "../src/world/voxelGrid";
import { carveSphere } from "../src/destruction/carve";
import { VOXEL } from "../src/config";

// The blast path (carveSphere) and the bullet path (game.ts applyBulletHit) share ONE predicate,
// grid.isIndestructible — so the forest wall + gate vehicles survive every weapon. carveSphere is a pure
// function testable with a stub sink; the bullet path is exercised by inspection over the same predicate.
const STUB = { debris: { spawn: () => false }, particles: { burst: () => {} } };

describe("indestructible voxels — the forest wall / gate vehicles", () => {
  it("set/get preserve the material through the narrowed 0x3f mask, and the flag rides the byte", () => {
    const g = new VoxelGrid();
    g.set(1, 0, 1, "leaves");
    expect(g.get(1, 0, 1)).toBe("leaves");
    expect(g.isIndestructible(1, 0, 1)).toBe(false);

    g.markIndestructibleBox(0, 2, 0, 2, 0, 2);
    expect(g.isIndestructible(1, 0, 1)).toBe(true);
    expect(g.get(1, 0, 1)).toBe("leaves"); // material intact after flagging (mask 0x3f leaves it untouched)

    g.set(1, 0, 1, "wood"); // overwriting the material keeps the indestructible flag (like weak)
    expect(g.get(1, 0, 1)).toBe("wood");
    expect(g.isIndestructible(1, 0, 1)).toBe(true);
  });

  it("markIndestructibleBox only touches REAL voxels, so a generous air bound is safe", () => {
    const g = new VoxelGrid();
    g.set(5, 0, 5, "concrete");
    g.markIndestructibleBox(0, 10, 0, 10, 0, 10); // mostly air
    expect(g.isIndestructible(5, 0, 5)).toBe(true);
    expect(g.isIndestructible(0, 0, 0)).toBe(false); // an empty cell is never flagged…
    expect(g.has(0, 0, 0)).toBe(false);              // …and stays empty
  });

  it("an explosion CANNOT carve indestructible voxels — but CAN carve a normal slab (positive control)", () => {
    const build = (): VoxelGrid => {
      const g = new VoxelGrid();
      for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) g.set(x, 0, z, "leaves"); // weak (strength 18)
      return g;
    };
    const cx = 3 * VOXEL, cy = 0.5 * VOXEL, cz = 3 * VOXEL, R = 1.0, ENERGY = 5000;

    const normal = build();
    const rn = carveSphere({ grid: normal, ...STUB } as never, cx, cy, cz, R, ENERGY, 8, 1);
    expect(rn.removed).toBeGreaterThan(0); // a huge blast levels ordinary leaves

    const hard = build();
    hard.markIndestructibleBox(0, 5, 0, 0, 0, 5); // flag the whole slab
    const rh = carveSphere({ grid: hard, ...STUB } as never, cx, cy, cz, R, ENERGY, 8, 1);
    expect(rh.removed).toBe(0); // the SAME blast carves NOTHING
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) expect(hard.has(x, 0, z)).toBe(true); // all intact
  });
});
