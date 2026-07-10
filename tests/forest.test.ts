import { describe, it, expect } from "vitest";
import { VoxelGrid } from "../src/world/voxelGrid";
import { buildDefaultScene, setWorldSeed, CITY_VOX } from "../src/build/prefabs";
import { carveSphere } from "../src/destruction/carve";
import { VOXEL } from "../src/config";

const build = (seed = 1): VoxelGrid => { setWorldSeed(seed); const g = new VoxelGrid(); buildDefaultScene(g); return g; };
const STUB = { debris: { spawn: () => false }, particles: { burst: () => {} } };

describe("static forest wall — the indestructible map boundary", () => {
  it("rings the city with a treeline BEYOND the footprint, and EVERY voxel of it is indestructible", () => {
    const g = build();
    let forest = 0, breakable = 0;
    for (let x = -30; x < -7; x++)                 // the west forest band (just outside the city)
      for (let y = 0; y < 16; y++)
        for (let z = 60; z < CITY_VOX.z1; z++)     // z≥60 skips the one legacy decorative car parked at (-16, 8)
          if (g.has(x, y, z)) { forest++; if (!g.isIndestructible(x, y, z)) breakable++; }
    expect(forest).toBeGreaterThan(50);            // a real wall of trees/hedge is out there
    expect(breakable).toBe(0);                     // …and NOTHING in it can be destroyed
  });

  it("the south gate is sealed by indestructible vehicles (metal), not left open", () => {
    const g = build();
    let metal = 0, breakable = 0;
    for (let x = 220; x < 300; x++)                // the N-S boulevard's south exit, straddled by trucks
      for (let y = 0; y < 10; y++)
        for (let z = -20; z < -6; z++)
          if (g.get(x, y, z) === "metal") { metal++; if (!g.isIndestructible(x, y, z)) breakable++; }
    expect(metal).toBeGreaterThan(20);             // truck steel plugs the road
    expect(breakable).toBe(0);
  });

  it("is grounded and deterministic (identical per seed; the city inside still varies)", () => {
    expect(build(1).size).toBe(build(1).size);     // same seed → identical world
    expect(build(1).size).not.toBe(build(2).size); // a different seed drives a different city
    const g = build(1);                            // spot-check the forest reaches the ground (trunk/hedge from y=0)
    let grounded = false;
    for (let x = -30; x < -7 && !grounded; x++) for (let z = 0; z < 120; z++) if (g.has(x, 0, z)) { grounded = true; break; }
    expect(grounded).toBe(true);
  });

  it("ADVERSARIAL: a point-blank massive blast (grenades/rockets/cannon all route through carveSphere) leaves it intact", () => {
    const g = build();
    const region = (): number => { let n = 0; for (let x = -28; x < -8; x++) for (let y = 0; y < 14; y++) for (let z = 280; z < 320; z++) if (g.has(x, y, z)) n++; return n; };
    const before = region();
    expect(before).toBeGreaterThan(20);            // there's a chunk of wall to attack
    const res = carveSphere({ grid: g, ...STUB } as never, -18 * VOXEL, 4 * VOXEL, 300 * VOXEL, 3.0, 100000, 8, 1); // enormous charge
    expect(res.removed).toBe(0);                   // the blast carves NOTHING out of the wall
    expect(region()).toBe(before);                 // …the treeline is exactly as it was
  });
});
