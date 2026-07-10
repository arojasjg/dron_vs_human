import { describe, it, expect } from "vitest";
import { applyDeath, checkWin, reconcileKills, baseAlert, type MatchState } from "../src/net/objectives";

describe("base-under-attack alerts", () => {
  it("fires one alert per downward threshold crossing, none while stable or healing", () => {
    expect(baseAlert(1, 0.8)).toBeNull();      // still above 75%
    expect(baseAlert(1, 0.7)).toBe(0.75);      // crossed 75%
    expect(baseAlert(0.6, 0.4)).toBe(0.5);     // crossed 50%
    expect(baseAlert(0.4, 0.2)).toBe(0.25);    // crossed 25%
    expect(baseAlert(0.1, 0)).toBe(0);         // destroyed
    expect(baseAlert(0.5, 0.5)).toBeNull();    // no change → no repeat alert
    expect(baseAlert(0.3, 0.9)).toBeNull();    // healing → no alert
  });

  it("a mega-bomb that blows through several thresholds reports the MOST URGENT (lowest) crossed", () => {
    expect(baseAlert(1, 0.1)).toBe(0.25);      // 1 → 0.1 crosses 75/50/25 → the lowest crossed is 25%
    expect(baseAlert(1, 0)).toBe(0);           // 1 → 0 crosses all incl. destroyed → 0
  });
});
import { BIG, OBJECTIVE_SITES, buildDefaultScene, buildObjectives, objectiveAlive, objectiveHp, objectiveDestroyed, setWorldSeed } from "../src/build/prefabs";
import type { MaterialId } from "../src/world/materials";

const STRIDE = BIG.H + 1;

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
}

const base = (o: Partial<MatchState> = {}): MatchState =>
  ({ droneObjsAlive: 2, humanObjsAlive: 2, droneKills: 0, humanKills: 0, ...o });

describe("checkWin — destroy BOTH enemy bases (or deathmatch)", () => {
  it("nobody wins while any enemy base stands and kills are below the limit", () => {
    expect(checkWin(base(), 10)).toBeNull();
    expect(checkWin(base({ humanObjsAlive: 1 }), 10)).toBeNull(); // one human base still up → drones haven't won
  });
  it("destroying BOTH enemy bases wins", () => {
    expect(checkWin(base({ humanObjsAlive: 0 }), 10)).toBe("drone");
    expect(checkWin(base({ droneObjsAlive: 0 }), 10)).toBe("human");
  });
  it("reaching the kill limit wins", () => {
    expect(checkWin(base({ droneKills: 10 }), 10)).toBe("drone");
    expect(checkWin(base({ humanKills: 12 }), 10)).toBe("human");
  });
  it("a simultaneous finish goes to the team with more kills (deterministic tiebreak)", () => {
    expect(checkWin(base({ droneObjsAlive: 0, humanObjsAlive: 0, droneKills: 3, humanKills: 5 }), 10)).toBe("human");
  });
});

describe("objective placement (DvH bases)", () => {
  const built = (seed = 1) => {
    const g = new MockGrid();
    setWorldSeed(seed);
    buildDefaultScene(g as never);
    buildObjectives(g as never);
    return g;
  };

  it("sites TWO bases per team — humans on the ground (in buildings), drones on rooftops", () => {
    const g = built();
    expect(OBJECTIVE_SITES).toHaveLength(4);
    const drones = OBJECTIVE_SITES.filter((s) => s.team === "drone");
    const humans = OBJECTIVE_SITES.filter((s) => s.team === "human");
    expect(drones).toHaveLength(2);
    expect(humans).toHaveLength(2);
    for (const human of humans) {
      expect(human.y0).toBe(1);
      expect(g.get(human.x0, human.y0, human.z0)).toBe("metal");
      expect(g.has(human.x0, 0, human.z0)).toBe(true); // floor slab underneath → inside a building
      expect(human.initial).toBeGreaterThan(0);        // records its voxel count for HP
    }
    for (const drone of drones) {
      expect(drone.y0).toBeGreaterThan(STRIDE);         // well up on a rooftop
      expect(g.get(drone.x0, drone.y0, drone.z0)).toBe("metal");
      expect(drone.initial).toBeGreaterThan(0);
    }
    // the two bases of a team sit in DIFFERENT buildings (distinct positions)
    expect(drones[0].x0 !== drones[1].x0 || drones[0].z0 !== drones[1].z0).toBe(true);
    expect(humans[0].x0 !== humans[1].x0 || humans[0].z0 !== humans[1].z0).toBe(true);
  });

  it("objectiveAlive follows the destruction of each base", () => {
    const g = built();
    for (const site of OBJECTIVE_SITES) {
      const has = (x: number, y: number, z: number) => g.has(x, y, z);
      expect(objectiveAlive(site, has)).toBe(true);
      for (let x = site.x0; x <= site.x1; x++)
        for (let y = site.y0; y <= site.y1; y++)
          for (let z = site.z0; z <= site.z1; z++) g.remove(x, y, z);
      expect(objectiveAlive(site, has)).toBe(false);
    }
  });

  it("objectiveHp drops from 1 to 0 as a base is chewed away; destroyed at ~75% razed", () => {
    const g = built();
    const mat = (x: number, y: number, z: number) => g.get(x, y, z) as MaterialId | undefined;
    const site = OBJECTIVE_SITES[0];
    expect(objectiveHp(site, mat)).toBeCloseTo(1);       // pristine
    expect(objectiveDestroyed(site, mat)).toBe(false);
    // remove ~85% of its voxels
    let removed = 0; const budget = Math.ceil(site.initial * 0.85);
    outer: for (let x = site.x0; x <= site.x1; x++)
      for (let y = site.y0; y <= site.y1; y++)
        for (let z = site.z0; z <= site.z1; z++) { if (g.has(x, y, z)) { g.remove(x, y, z); if (++removed >= budget) break outer; } }
    expect(objectiveHp(site, mat)).toBeLessThan(0.25);
    expect(objectiveDestroyed(site, mat)).toBe(true);    // ≥75% gone → counts as destroyed
  });

  it("is deterministic — same seed sites the bases identically", () => {
    built(7);
    const a = OBJECTIVE_SITES.map((s) => ({ ...s }));
    built(7);
    expect(OBJECTIVE_SITES).toEqual(a);
  });
});

describe("applyDeath — team kill scoring", () => {
  const s: MatchState = { droneObjsAlive: 2, humanObjsAlive: 2, droneKills: 0, humanKills: 0 };
  it("a human death scores for the drones, a drone death for the humans", () => {
    expect(applyDeath(s, "human").droneKills).toBe(1);
    expect(applyDeath(s, "drone").humanKills).toBe(1);
  });
  it("does not mutate the input state", () => {
    applyDeath(s, "human");
    expect(s.droneKills).toBe(0);
  });
});

describe("reconcileKills — self-healing scoreboard", () => {
  it("takes the max per team (a client that missed a death catches up)", () => {
    expect(reconcileKills({ drone: 3, human: 1 }, { drone: 2, human: 4 })).toEqual({ drone: 3, human: 4 });
  });
  it("is idempotent and monotonic", () => {
    const a = { drone: 5, human: 2 };
    expect(reconcileKills(a, a)).toEqual(a);                                   // idempotent
    const merged = reconcileKills(a, { drone: 1, human: 9 });
    expect(merged.drone).toBeGreaterThanOrEqual(a.drone);                      // never decreases
    expect(merged.human).toBeGreaterThanOrEqual(a.human);
  });
});
