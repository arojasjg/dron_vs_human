import { describe, it, expect } from "vitest";
import { assignRole, roleMaxHp, roleWeapon, teamCounts, teamForRole, enemyTeam, playerRoster, type Role, type ScoreRow } from "../src/net/roles";
import { applyDeath, type MatchState } from "../src/net/objectives";

describe("assignRole — balanced drone/human teams", () => {
  it("fills the smaller team first", () => {
    expect(assignRole(["drone"], 5)).toBe("human");
    expect(assignRole(["human", "human"], 5)).toBe("drone");
    expect(assignRole(["drone", "human", "human"], 5)).toBe("drone");
  });

  it("breaks an exact tie deterministically by id parity", () => {
    expect(assignRole([], 2)).toBe("drone");
    expect(assignRole([], 3)).toBe("human");
    expect(assignRole(["drone", "human"], 4)).toBe("drone");
    // deterministic: same inputs → same result on every client
    expect(assignRole(["drone", "human"], 4)).toBe(assignRole(["drone", "human"], 4));
  });

  it("keeps the two teams within one of each other across a run of joins", () => {
    const roster: Role[] = [];
    for (let id = 1; id <= 14; id++) {
      roster.push(assignRole(roster, id));
      const { drones, humans } = teamCounts(roster);
      expect(Math.abs(drones - humans)).toBeLessThanOrEqual(1);
    }
    expect(roster.length).toBe(14);
  });

  it("makes humans tankier than drones", () => {
    expect(roleMaxHp("human")).toBeGreaterThan(roleMaxHp("drone"));
    expect(roleMaxHp("drone")).toBeGreaterThan(0);
  });

  it("gives the drone fast light weapons and the human slow heavy ones", () => {
    const d = roleWeapon("drone"), h = roleWeapon("human");
    expect(d.cooldownMul).toBeLessThan(h.cooldownMul); // drone reloads faster
    expect(h.powerMul).toBeGreaterThan(d.powerMul);     // human blasts harder
    for (const m of [d, h]) {
      expect(m.cooldownMul).toBeGreaterThan(0);          // never free-fire or divide-by-zero
      expect(m.powerMul).toBeGreaterThan(0);
    }
  });
});

describe("teamForRole — dvh side derives from the role", () => {
  it("puts drones on team 0 and humans on team 1", () => {
    expect(teamForRole("drone")).toBe(0);
    expect(teamForRole("human")).toBe(1);
  });

  it("keeps the two roles on OPPOSITE teams (cross-role = enemy, same-role = friendly)", () => {
    expect(teamForRole("drone")).not.toBe(teamForRole("human"));
    expect(enemyTeam(teamForRole("drone"))).toBe(teamForRole("human"));
  });

  it("scores kills on the SAME axis friendly-fire uses: a human death credits the drone side", () => {
    const s0: MatchState = { droneObjsAlive: 2, humanObjsAlive: 2, droneKills: 0, humanKills: 0 };
    const s1 = applyDeath(s0, "human"); // in dvh only a cross-team (= cross-role) shot can kill
    expect(s1.droneKills).toBe(1);
    expect(s1.humanKills).toBe(0);
    // the crediting side IS the killer's derived team — no independent Rojo/Azul pick can disagree
    expect(teamForRole("drone")).toBe(0);
    expect(teamForRole("drone")).not.toBe(teamForRole("human"));
  });
});

describe("playerRoster — drops AI-bot avatars (negative ids)", () => {
  const row = (id: number): ScoreRow => ({ id, team: 0, isHuman: true, kills: 0, assists: 0, deaths: 0, you: false });

  it("removes negative-id rows and keeps the survivors in order", () => {
    const out = playerRoster([-3, -1, 0, 2, 5].map(row));
    expect(out.map((r) => r.id)).toEqual([0, 2, 5]);
  });

  it("keeps an all-positive roster unchanged", () => {
    const rows = [1, 2, 3].map(row);
    expect(playerRoster(rows)).toEqual(rows);
  });

  it("keeps id 0 — the offline local player (net.id is 0 before the relay hello)", () => {
    expect(playerRoster([row(0)]).map((r) => r.id)).toEqual([0]);
  });

  it("returns [] for an all-negative input", () => {
    expect(playerRoster([-1, -2, -60].map(row))).toEqual([]);
  });
});
