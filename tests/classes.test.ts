import { describe, it, expect } from "vitest";
import {
  SOLDIER_CLASSES, DRONE_CLASSES, classStats, classMaxHp, classLoadout, classMove, classList,
  defaultClass, enemyTeam, roleMaxHp, type ClassStats,
} from "../src/net/roles";
import { WEAPONS, roleLoadout, type Weapon } from "../src/net/weapons";

// A coarse "range" score by primary weapon — encodes the tactical reach of each class's main gun.
const RANGE: Record<string, number> = { smg: 1, shotgun: 1, mg: 2, lmg: 2, grenade: 2, kamikaze: 1, dmr: 3, sniper: 4 };

function leaders(table: Record<string, ClassStats>) {
  const e = Object.entries(table);
  const maxHp = Math.max(...e.map(([, s]) => s.maxHp));
  const maxMove = Math.max(...e.map(([, s]) => s.moveMul));
  const maxRange = Math.max(...e.map(([, s]) => RANGE[s.loadout[0]]));
  return {
    hp: e.filter(([, s]) => s.maxHp === maxHp),
    move: e.filter(([, s]) => s.moveMul === maxMove),
    range: e.filter(([, s]) => RANGE[s.loadout[0]] === maxRange),
  };
}

describe("class balance — no dominant class (rock-paper-scissors, not a ladder)", () => {
  for (const [side, table] of [["soldier", SOLDIER_CLASSES], ["drone", DRONE_CLASSES]] as const) {
    it(`${side}: the HP, speed and range leaders are three DIFFERENT classes`, () => {
      const L = leaders(table);
      // exactly one clear leader on each axis
      expect(L.hp.length).toBe(1);
      expect(L.move.length).toBe(1);
      expect(L.range.length).toBe(1);
      // and no class holds two of those crowns at once
      const hp = L.hp[0][0], move = L.move[0][0], range = L.range[0][0];
      expect(hp).not.toBe(move);
      expect(hp).not.toBe(range);
      expect(move).not.toBe(range);
    });

    it(`${side}: every class has a non-empty loadout drawn only from real weapons`, () => {
      for (const s of Object.values(table)) {
        expect(s.loadout.length).toBeGreaterThan(0);
        for (const w of s.loadout) expect(WEAPONS[w as Weapon]).toBeTruthy();
        expect(s.maxHp).toBeGreaterThan(0);
        expect(s.moveMul).toBeGreaterThan(0);
        expect(s.label.length).toBeGreaterThan(0);
      }
    });
  }

  it("soldiers: tank has the most HP, scout is the fastest, marksman reaches farthest", () => {
    expect(SOLDIER_CLASSES.heavy.maxHp).toBeGreaterThan(SOLDIER_CLASSES.assault.maxHp);
    expect(SOLDIER_CLASSES.assault.maxHp).toBeGreaterThan(SOLDIER_CLASSES.scout.maxHp);
    expect(SOLDIER_CLASSES.scout.moveMul).toBeGreaterThan(SOLDIER_CLASSES.assault.moveMul);
    expect(SOLDIER_CLASSES.assault.moveMul).toBeGreaterThan(SOLDIER_CLASSES.heavy.moveMul);
    expect(SOLDIER_CLASSES.marksman.loadout[0]).toBe("sniper");
    expect(SOLDIER_CLASSES.scout.loadout[0]).toBe("smg");
    expect(SOLDIER_CLASSES.heavy.loadout[0]).toBe("lmg");
  });

  it("drones: armor has the most HP, interceptor is the fastest, artillery reaches farthest", () => {
    expect(DRONE_CLASSES.armor.maxHp).toBeGreaterThan(DRONE_CLASSES.assault.maxHp);
    expect(DRONE_CLASSES.assault.maxHp).toBeGreaterThan(DRONE_CLASSES.interceptor.maxHp);
    expect(DRONE_CLASSES.interceptor.moveMul).toBeGreaterThan(DRONE_CLASSES.assault.moveMul);
    expect(DRONE_CLASSES.assault.moveMul).toBeGreaterThan(DRONE_CLASSES.armor.moveMul);
    expect(DRONE_CLASSES.artillery.loadout[0]).toBe("dmr");
    expect(DRONE_CLASSES.interceptor.loadout[0]).toBe("smg");
  });

  it("the balanced 'assault' is nobody's extreme (middle HP, middle speed)", () => {
    for (const table of [SOLDIER_CLASSES, DRONE_CLASSES]) {
      const a = table.assault;
      const hps = Object.values(table).map((s) => s.maxHp);
      expect(a.maxHp).toBeLessThan(Math.max(...hps));
      expect(a.maxHp).toBeGreaterThan(Math.min(...hps));
      expect(a.moveMul).toBe(1);
    }
  });
});

describe("class lookups — fallbacks stay backward-safe", () => {
  it("classMaxHp / classLoadout fall back to the role default when no class is given", () => {
    expect(classMaxHp("drone")).toBe(roleMaxHp("drone"));   // 80
    expect(classMaxHp("human")).toBe(roleMaxHp("human"));   // 150
    expect(classLoadout("drone")).toEqual(roleLoadout("drone"));
    expect(classLoadout("human")).toEqual(roleLoadout("human"));
  });

  it("an unknown class degrades to that side's assault (older peer safe)", () => {
    expect(classStats("human", "bogus").label).toBe(SOLDIER_CLASSES.assault.label);
    expect(classStats("drone", undefined).label).toBe(DRONE_CLASSES.assault.label);
    expect(classMaxHp("human", "bogus")).toBe(SOLDIER_CLASSES.assault.maxHp);
  });

  it("classMaxHp / classLoadout / classMove read the chosen class", () => {
    expect(classMaxHp("human", "heavy")).toBe(260);
    expect(classLoadout("human", "scout")[0]).toBe("smg");
    expect(classMove("human", "scout").speedMul).toBeGreaterThan(1);
    expect(classMove("human", "heavy").speedMul).toBeLessThan(1);
    expect(classMove("drone", "interceptor").speedMul).toBeGreaterThan(1);
  });

  it("classList returns the 4 selectable classes per role, in order", () => {
    expect(classList("human").map((c) => c.id)).toEqual(["assault", "scout", "heavy", "marksman"]);
    expect(classList("drone").map((c) => c.id)).toEqual(["assault", "interceptor", "armor", "artillery"]);
    expect(defaultClass("human")).toBe("assault");
  });
});

describe("class display profile — pros/cons + 1-5 stat bars for the lobby preview", () => {
  for (const [side, table] of [["soldier", SOLDIER_CLASSES], ["drone", DRONE_CLASSES]] as const) {
    it(`${side}: every class has pros, cons, and a valid 1-5 profile`, () => {
      for (const s of Object.values(table)) {
        expect(s.pros.length).toBeGreaterThanOrEqual(1);
        expect(s.cons.length).toBeGreaterThanOrEqual(1);
        for (const t of s.pros) expect(t.length).toBeGreaterThan(0);
        for (const v of [s.profile.armor, s.profile.mobility, s.profile.range, s.profile.firepower]) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(5);
        }
      }
    });

    it(`${side}: the profile matches the balance table (armor↔HP, mobility↔speed, range↔primary)`, () => {
      const e = Object.entries(table);
      const top = (sel: (p: typeof e[0][1]["profile"]) => number) => e.filter(([, s]) => sel(s.profile) === 5).map(([k]) => k);
      const armorLead = top((p) => p.armor), moveLead = top((p) => p.mobility), rangeLead = top((p) => p.range);
      // exactly one class maxes each axis, and they are three DIFFERENT classes
      expect(armorLead.length).toBe(1);
      expect(moveLead.length).toBe(1);
      expect(rangeLead.length).toBe(1);
      expect(new Set([armorLead[0], moveLead[0], rangeLead[0]]).size).toBe(3);
      // the profile leader on each axis is the same class the numeric stats crown
      const maxHp = Math.max(...e.map(([, s]) => s.maxHp));
      const maxMove = Math.max(...e.map(([, s]) => s.moveMul));
      expect(table[armorLead[0] as keyof typeof table].maxHp).toBe(maxHp);
      expect(table[moveLead[0] as keyof typeof table].moveMul).toBe(maxMove);
      // no class maxes armor AND mobility AND range at once (no-dominance holds on the bars too)
      for (const [, s] of e) expect(s.profile.armor === 5 && s.profile.mobility === 5 && s.profile.range === 5).toBe(false);
    });

    it(`${side}: the balanced assault maxes NO survivability/mobility/range axis`, () => {
      const p = table.assault.profile;
      expect(p.armor).toBeLessThan(5);
      expect(p.mobility).toBeLessThan(5);
      expect(p.range).toBeLessThan(5);
    });
  }
});

describe("team axis — independent of role", () => {
  it("enemyTeam flips the side", () => {
    expect(enemyTeam(0)).toBe(1);
    expect(enemyTeam(1)).toBe(0);
  });
});
