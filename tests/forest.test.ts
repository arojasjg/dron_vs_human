import { describe, it, expect } from "vitest";
import { VoxelGrid } from "../src/world/voxelGrid";
import { buildDefaultScene, setWorldSeed, CITY_VOX, FOREST_RING } from "../src/build/prefabs";
import { carveSphere } from "../src/destruction/carve";
import { VOXEL } from "../src/config";

const build = (seed = 1): VoxelGrid => { setWorldSeed(seed); const g = new VoxelGrid(); buildDefaultScene(g); return g; };
const STUB = { debris: { spawn: () => false }, particles: { burst: () => {} } };

// Treeline geometry, DERIVED from the builder's single source of truth (never hardcode — the band moves when
// the constants change). The west treeline spans x ∈ [-treeOuter, -treeInner] (voxels), set back from the city.
const treeInner = FOREST_RING.hedgeInset + FOREST_RING.treeGap;
const treeOuter = treeInner + FOREST_RING.depth;
const westMid = -Math.round((treeInner + treeOuter) / 2);

describe("static forest wall — the indestructible map boundary", () => {
  it("rings the city with a treeline SET BACK beyond the footprint, and EVERY voxel of it is indestructible", () => {
    const g = build();
    let forest = 0, breakable = 0;
    for (let x = -treeOuter; x <= -treeInner; x++)     // the west treeline (set back from the city by treeInner)
      for (let y = 0; y < 16; y++)
        for (let z = 0; z < CITY_VOX.z1; z++)
          if (g.has(x, y, z)) { forest++; if (!g.isIndestructible(x, y, z)) breakable++; }
    expect(forest).toBeGreaterThan(50);            // a real wall of trees is out there
    expect(breakable).toBe(0);                     // …and NOTHING in it can be destroyed
  });

  it("leaves a clearing: the treeline canopy stays set back from the perimeter buildings", () => {
    const g = build();
    // scan inward from the city edge (x=0) toward the treeline; find the canopy voxel CLOSEST to the city.
    let innermostX = -treeOuter;
    for (let x = -1; x >= -treeOuter && innermostX === -treeOuter; x--)
      for (let y = FOREST_RING.hedgeTop + 1; y < 16; y++)
        for (let z = 200; z < 400; z++)
          if (g.get(x, y, z) === "leaves") { innermostX = x; break; }
    // the nearest treetop must sit BEYOND the hedge (well back from the buildings), not crowding them like before
    expect(Math.abs(innermostX)).toBeGreaterThan(FOREST_RING.hedgeInset); // trees are past the boundary hedge, not against the city
  });

  it("the south gate is sealed by indestructible vehicles (metal), not left open", () => {
    const g = build();
    const gateZ = -FOREST_RING.hedgeInset - 8;     // trucks straddle the boulevard just outside the south hedge
    let metal = 0, breakable = 0;
    for (let x = 220; x < 300; x++)                // the N-S boulevard's south exit, straddled by trucks
      for (let y = 0; y < 10; y++)
        for (let z = gateZ - 6; z < gateZ + 12; z++)
          if (g.get(x, y, z) === "metal") { metal++; if (!g.isIndestructible(x, y, z)) breakable++; }
    expect(metal).toBeGreaterThan(20);             // truck steel plugs the road
    expect(breakable).toBe(0);
  });

  it("is grounded and deterministic (identical per seed; the city inside still varies)", () => {
    expect(build(1).size).toBe(build(1).size);     // same seed → identical world
    expect(build(1).size).not.toBe(build(2).size); // a different seed drives a different city
    const g = build(1);                            // spot-check the forest/hedge reaches the ground (trunk/hedge from y=0)
    let grounded = false;
    for (let x = -treeOuter; x <= -FOREST_RING.hedgeInset && !grounded; x++)
      for (let z = 0; z < 120; z++) if (g.has(x, 0, z)) { grounded = true; break; }
    expect(grounded).toBe(true);
  });

  it("ADVERSARIAL: a point-blank massive blast (grenades/rockets/cannon all route through carveSphere) leaves it intact", () => {
    const g = build();
    const region = (): number => { let n = 0; for (let x = westMid - 10; x <= westMid + 10; x++) for (let y = 0; y < 14; y++) for (let z = 280; z < 320; z++) if (g.has(x, y, z)) n++; return n; };
    const before = region();
    expect(before).toBeGreaterThan(20);            // there's a chunk of wall to attack
    const res = carveSphere({ grid: g, ...STUB } as never, westMid * VOXEL, 4 * VOXEL, 300 * VOXEL, 3.0, 100000, 8, 1); // enormous charge
    expect(res.removed).toBe(0);                   // the blast carves NOTHING out of the wall
    expect(region()).toBe(before);                 // …the treeline is exactly as it was
  });
});
