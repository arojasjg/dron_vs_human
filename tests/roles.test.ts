import { describe, it, expect } from "vitest";
import { assignRole, roleMaxHp, roleWeapon, teamCounts, type Role } from "../src/net/roles";

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
