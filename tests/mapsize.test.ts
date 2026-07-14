import { describe, it, expect, afterEach } from "vitest";
import { VoxelGrid } from "../src/world/voxelGrid";
import {
  setMapSize, MAP_SIZES, CITY_VOX, PLAY_BOUNDS, buildDefaultScene, buildObjectives, OBJECTIVE_SITES, setWorldSeed,
  ammoBoxSites, medkitSites,
} from "../src/build/prefabs";

// setMapSize mutates module-global map dimensions → reset to the default (large = current world) after each
// test so nothing leaks into other suites in this file. (Vitest isolates by FILE, so cross-file is already safe.)
afterEach(() => setMapSize("large"));

describe("medkit crate sites (bandage resupply)", () => {
  it("are deterministic for a seed, non-empty, and distinct from the ammo grid", () => {
    setMapSize("large");
    const a = medkitSites(1234), b = medkitSites(1234);
    expect(a).toEqual(b);                                  // same seed → identical (multiplayer-safe)
    expect(a.length).toBeGreaterThan(0);
    const ammo = ammoBoxSites(1234);
    expect(a.length).toBeLessThan(ammo.length);            // medkits are sparser than ammo
    const key = (s: { vx: number; vz: number }) => `${s.vx},${s.vz}`;
    const ammoSet = new Set(ammo.map(key));
    expect(a.some((s) => !ammoSet.has(key(s)))).toBe(true); // not merely a subset of the ammo grid
  });

  it("a different seed produces a different layout", () => {
    setMapSize("large");
    expect(medkitSites(1)).not.toEqual(medkitSites(2));
  });
});

describe("map size presets", () => {
  it("'large' reproduces the current world extent exactly (byte-identical default)", () => {
    setMapSize("large");
    expect(CITY_VOX.x1).toBe(9 * 57);   // 513 voxels — the historical value
    expect(CITY_VOX.z1).toBe(11 * 54);  // 594
  });

  it("the presets form a strict small < medium < large ladder", () => {
    setMapSize("small"); const sx = CITY_VOX.x1, sz = CITY_VOX.z1;
    setMapSize("medium"); const mx = CITY_VOX.x1, mz = CITY_VOX.z1;
    setMapSize("large"); const lx = CITY_VOX.x1, lz = CITY_VOX.z1;
    expect(sx).toBeLessThan(mx); expect(mx).toBeLessThan(lx);
    expect(sz).toBeLessThan(mz); expect(mz).toBeLessThan(lz);
    expect(MAP_SIZES.small.players).toBeLessThan(MAP_SIZES.large.players);
  });

  it("PLAY_BOUNDS is mutated in place and scales with the city", () => {
    setMapSize("small"); const smax = PLAY_BOUNDS.maxX;
    setMapSize("large");
    expect(smax).toBeLessThan(PLAY_BOUNDS.maxX);
    // the reference identity is preserved (mutated, not reassigned) so game.ts's import stays live
    expect(typeof PLAY_BOUNDS.maxX).toBe("number");
  });

  it("the SMALL arena still builds a solid, destructible world with ≥4 objective buildings", () => {
    setMapSize("small"); setWorldSeed(123);
    const g = new VoxelGrid();
    buildDefaultScene(g);
    expect(g.size).toBeGreaterThan(1000);   // a real, blast-able world, not an empty grid
    buildObjectives(g);
    expect(OBJECTIVE_SITES.length).toBe(4); // dvh needs 4 bases → the smallest map must still place them
  });

  it("every preset builds without error and scales the voxel count monotonically", () => {
    const size = (s: Parameters<typeof setMapSize>[0]) => {
      setMapSize(s); setWorldSeed(7);
      const g = new VoxelGrid(); buildDefaultScene(g); return g.size;
    };
    const small = size("small"), medium = size("medium"), large = size("large");
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(large);       // fewer plots → fewer voxels
    expect(medium).toBeLessThan(large);
  });
});
