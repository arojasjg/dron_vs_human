import { describe, it, expect } from "vitest";
import { applyDeath, checkWin, reconcileKills, type MatchState } from "../src/net/objectives";
import { BIG, OBJECTIVE_SITES, buildDefaultScene, buildObjectives, objectiveAlive, setWorldSeed } from "../src/build/prefabs";

const STRIDE = BIG.H + 1;

class MockGrid {
  m = new Map<string, string>();
  private k(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  set(x: number, y: number, z: number, mat: string) { this.m.set(this.k(x, y, z), mat); }
  remove(x: number, y: number, z: number) { this.m.delete(this.k(x, y, z)); }
  has(x: number, y: number, z: number) { return this.m.has(this.k(x, y, z)); }
  get(x: number, y: number, z: number) { return this.m.get(this.k(x, y, z)); }
  markSettled() {}
  clear() { this.m.clear(); }
}

const base = (o: Partial<MatchState> = {}): MatchState =>
  ({ droneObjAlive: true, humanObjAlive: true, droneKills: 0, humanKills: 0, ...o });

describe("checkWin — destructible objective + deathmatch", () => {
  it("nobody wins while both objectives stand and kills are below the limit", () => {
    expect(checkWin(base(), 10)).toBeNull();
  });
  it("destroying the enemy objective wins", () => {
    expect(checkWin(base({ humanObjAlive: false }), 10)).toBe("drone");
    expect(checkWin(base({ droneObjAlive: false }), 10)).toBe("human");
  });
  it("reaching the kill limit wins", () => {
    expect(checkWin(base({ droneKills: 10 }), 10)).toBe("drone");
    expect(checkWin(base({ humanKills: 12 }), 10)).toBe("human");
  });
  it("a simultaneous finish goes to the team with more kills (deterministic tiebreak)", () => {
    expect(checkWin(base({ droneObjAlive: false, humanObjAlive: false, droneKills: 3, humanKills: 5 }), 10)).toBe("human");
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

  it("sites the human base on the ground (in a building) and the drone base on a rooftop", () => {
    const g = built();
    expect(OBJECTIVE_SITES).toHaveLength(2);
    const [drone, human] = OBJECTIVE_SITES;
    expect(drone.team).toBe("drone");
    expect(human.team).toBe("human");
    // human base: metal, on the ground floor, with the building's slab under it (i.e. inside a building)
    expect(human.y0).toBe(1);
    expect(g.get(human.x0, human.y0, human.z0)).toBe("metal");
    expect(g.has(human.x0, 0, human.z0)).toBe(true); // floor slab underneath → it is inside a building
    // drone base: metal, well up on a rooftop (several storeys above the ground)
    expect(drone.y0).toBeGreaterThan(STRIDE);
    expect(g.get(drone.x0, drone.y0, drone.z0)).toBe("metal");
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

  it("is deterministic — same seed sites the bases identically", () => {
    built(7);
    const a = OBJECTIVE_SITES.map((s) => ({ ...s }));
    built(7);
    expect(OBJECTIVE_SITES).toEqual(a);
  });
});

describe("applyDeath — team kill scoring", () => {
  const s: MatchState = { droneObjAlive: true, humanObjAlive: true, droneKills: 0, humanKills: 0 };
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
