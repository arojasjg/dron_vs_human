import { describe, it, expect } from "vitest";
import { respawnDelay, allDead, wallBlocks, smokeOccludes, perimeterSpawn, playerSpawn, cardinalSpawn, WAVE_DIRS, bandageStep, BANDAGE_DUR, canBeginMatch, type SmokeCloud } from "../src/net/coop";

const VOX = 0.25;
// mirror of PLAY_BOUNDS for the current-map extent (city 513×594 vox + 48-vox forest margin) so we can assert
// spawns land in the clear perimeter band, never outside the sealed playfield.
const bounds = (cx: number, cz: number) => ({
  minX: (-48 + 1) * VOX, maxX: (cx + 48) * VOX, minZ: (-48 + 1) * VOX, maxZ: (cz + 48) * VOX,
});

describe("player spawns — scaled to map size + player count (pure)", () => {
  const CX = 513, CZ = 594; // large map extent in voxels
  it("every spawn lands inside the sealed playfield (never in a wall/outside)", () => {
    const b = bounds(CX, CZ);
    for (const team of [0, 1, null] as const)
      for (let idx = 0; idx < 50; idx++) {
        const s = playerSpawn(CX, CZ, VOX, team, idx, 50);
        expect(s.x).toBeGreaterThanOrEqual(b.minX); expect(s.x).toBeLessThanOrEqual(b.maxX);
        expect(s.z).toBeGreaterThanOrEqual(b.minZ); expect(s.z).toBeLessThanOrEqual(b.maxZ);
      }
  });

  it("PvP splits the teams to opposite sides (team 0 west, team 1 east of centre)", () => {
    const centreX = CX * VOX * 0.5;
    for (let idx = 0; idx < 20; idx++) {
      expect(playerSpawn(CX, CZ, VOX, 0, idx, 50).x).toBeLessThan(centreX);
      expect(playerSpawn(CX, CZ, VOX, 1, idx, 50).x).toBeGreaterThan(centreX);
    }
  });

  it("distinct player indices get distinct positions (no stacking) for 50 players", () => {
    const seen = new Set<string>();
    for (let idx = 0; idx < 50; idx++) {
      const s = playerSpawn(CX, CZ, VOX, 0, idx, 50);
      const key = `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("stays inside the sealed field on a SMALL map too (offset 22 < forest margin 48)", () => {
    const sx = 285, sz = 270; // small preset extent (5×57 × 5×54)
    const b = bounds(sx, sz);
    for (const team of [0, 1, null] as const)
      for (let idx = 0; idx < 12; idx++) {
        const s = playerSpawn(sx, sz, VOX, team, idx, 6);
        expect(s.x).toBeGreaterThanOrEqual(b.minX); expect(s.x).toBeLessThanOrEqual(b.maxX);
        expect(s.z).toBeGreaterThanOrEqual(b.minZ); expect(s.z).toBeLessThanOrEqual(b.maxZ);
      }
  });

  it("a smaller map packs the spawns closer to the origin", () => {
    const big = playerSpawn(513, 594, VOX, 1, 10, 50).x;   // east band on the large map
    const small = playerSpawn(285, 285, VOX, 1, 10, 50).x; // east band on a small map (5×57 × 5×54-ish)
    expect(small).toBeLessThan(big);                        // the east edge is nearer on the small map
  });
});

describe("bandage channel (pure)", () => {
  it("completes after DUR seconds of holding, then resets", () => {
    let t = 0, done = false;
    // hold for exactly DUR seconds in small steps
    for (let i = 0; i < Math.ceil(BANDAGE_DUR / 0.1); i++) { const r = bandageStep(t, true, 0.1); t = r.t; done = r.done; if (done) break; }
    expect(done).toBe(true);
    expect(t).toBe(0);                    // resets on completion (ready for the next bandage)
  });

  it("interrupts (resets to 0) the moment it's not active — no partial credit", () => {
    let t = bandageStep(0, true, 1).t;    // 1s of a 2s channel
    expect(t).toBeCloseTo(1);
    const r = bandageStep(t, false, 0.1); // moved / fired / hit → active false
    expect(r.t).toBe(0);
    expect(r.done).toBe(false);
  });

  it("does not complete before DUR", () => {
    const r = bandageStep(BANDAGE_DUR - 0.2, true, 0.1);
    expect(r.done).toBe(false);
    expect(r.t).toBeGreaterThan(0);
  });
});

describe("enemy wave spawn — one cardinal point per wave, rotating N→S→E→O (pure)", () => {
  const CX = 513, CZ = 594, midX = CX * VOX * 0.5, midZ = CZ * VOX * 0.5;
  it("rotates through the four cardinals in order and wraps every 4 waves", () => {
    expect([0, 1, 2, 3, 4, 5].map((w) => cardinalSpawn(CX, CZ, VOX, w).dir)).toEqual(["N", "S", "E", "O", "N", "S"]);
    expect(WAVE_DIRS).toEqual(["N", "S", "E", "O"]);
  });

  it("each cardinal sits OUTSIDE the correct edge (N=−Z, S=+Z, E=+X, O=−X)", () => {
    const n = cardinalSpawn(CX, CZ, VOX, 0), s = cardinalSpawn(CX, CZ, VOX, 1);
    const e = cardinalSpawn(CX, CZ, VOX, 2), o = cardinalSpawn(CX, CZ, VOX, 3);
    expect(n.cz).toBeLessThan(0); expect(n.cx).toBeCloseTo(midX);      // north edge, centred on X
    expect(s.cz).toBeGreaterThan(CZ * VOX); expect(s.cx).toBeCloseTo(midX); // south, beyond the far edge
    expect(e.cx).toBeGreaterThan(CX * VOX); expect(e.cz).toBeCloseTo(midZ); // east, beyond the far edge
    expect(o.cx).toBeLessThan(0); expect(o.cz).toBeCloseTo(midZ);      // west, before the origin
  });

  it("the spawn cluster is negative-handles safe and stays near the map (margin < forest ring)", () => {
    expect(cardinalSpawn(CX, CZ, VOX, -1).dir).toBe(WAVE_DIRS[3]); // negative wave wraps cleanly (O)
    const off = 20 * VOX; // margin 20 voxels < 48-voxel forest margin → inside the playfield
    expect(Math.abs(cardinalSpawn(CX, CZ, VOX, 0).cz)).toBeLessThan(48 * VOX);
    expect(off).toBeLessThan(48 * VOX);
  });
});

describe("co-op survival rules (pure)", () => {
  it("respawnDelay is 10 s base and grows +5 s per prior death — 'entre más muere, más espera'", () => {
    expect(respawnDelay(1)).toBe(10);   // first death
    expect(respawnDelay(2)).toBe(15);
    expect(respawnDelay(3)).toBe(20);
    expect(respawnDelay(2)).toBeGreaterThan(respawnDelay(1)); // strictly grows with the death count
    expect(respawnDelay(0)).toBe(10);   // guards a zero
  });

  it("allDead is a team wipe only when everyone is down (and there IS someone)", () => {
    expect(allDead([0])).toBe(true);           // solo: your death ends it
    expect(allDead([0, 0, 0])).toBe(true);     // whole team down
    expect(allDead([0, 5, 0])).toBe(false);    // one teammate still alive → not a wipe
    expect(allDead([150])).toBe(false);        // alive
    expect(allDead([])).toBe(false);           // no players → not a wipe (guards an empty roster)
  });

  it("wallBlocks: a wall NEARER than the target stops the bullet; behind/at the target it doesn't", () => {
    expect(wallBlocks(20, 5)).toBe(true);      // wall at 5 m, drone at 20 m → blocked (no shooting through walls)
    expect(wallBlocks(20, 25)).toBe(false);    // wall behind the drone → the shot lands
    expect(wallBlocks(20, 19.9)).toBe(false);  // wall flush behind the drone (within margin) → still a hit
    expect(wallBlocks(20, 18)).toBe(true);     // wall clearly in front → blocked
  });

  it("smokeOccludes: an ACTIVE cloud on the sightline blocks it; off to the side / expired / behind doesn't", () => {
    const now = 0;
    const onLine: SmokeCloud[] = [{ x: 10, y: 0, z: 0, r: 5, until: 100 }]; // sits mid-segment (0,0,0)→(20,0,0)
    expect(smokeOccludes(onLine, now, 0, 0, 0, 20, 0, 0)).toBe(true);
    const aside: SmokeCloud[] = [{ x: 10, y: 0, z: 20, r: 5, until: 100 }]; // 20 m off to the side
    expect(smokeOccludes(aside, now, 0, 0, 0, 20, 0, 0)).toBe(false);
    const expired: SmokeCloud[] = [{ x: 10, y: 0, z: 0, r: 5, until: 100 }];
    expect(smokeOccludes(expired, 200, 0, 0, 0, 20, 0, 0)).toBe(false); // now(200) > until(100) → gone
    const behind: SmokeCloud[] = [{ x: -10, y: 0, z: 0, r: 5, until: 100 }]; // behind the shooter
    expect(smokeOccludes(behind, now, 0, 0, 0, 20, 0, 0)).toBe(false);
    expect(smokeOccludes([], now, 0, 0, 0, 20, 0, 0)).toBe(false); // no clouds
  });

  it("perimeterSpawn: the wave ring sits PAST the city half-extent → drones spawn OUTSIDE the city", () => {
    const VOXEL = 0.25;
    const s = perimeterSpawn(513, 594, VOXEL); // the real city extents
    const cityHalfX = 513 * 0.5 * VOXEL, cityHalfZ = 594 * 0.5 * VOXEL;
    expect(s.cx).toBeCloseTo(cityHalfX, 5);          // centred on the city
    expect(s.cz).toBeCloseTo(cityHalfZ, 5);
    expect(s.r).toBeGreaterThan(Math.max(cityHalfX, cityHalfZ)); // ring is beyond the city → outside
  });
});

describe("canBeginMatch — start/restart gate (pure)", () => {
  it("allows the first start from the menu or lobby", () => {
    expect(canBeginMatch("menu", false)).toBe(true);
    expect(canBeginMatch("lobby", false)).toBe(true);
  });

  it("BLOCKS a duplicate begin while a match is still live (no mid-fight world rebuild)", () => {
    expect(canBeginMatch("playing", false)).toBe(false);
  });

  it("allows a RESTART once the current match is over", () => {
    expect(canBeginMatch("playing", true)).toBe(true);
  });

  it("matchOver never gates a menu/lobby start (only relaxes the live-match block)", () => {
    expect(canBeginMatch("menu", true)).toBe(true);
    expect(canBeginMatch("lobby", true)).toBe(true);
  });
});
