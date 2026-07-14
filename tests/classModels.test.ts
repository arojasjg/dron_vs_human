import { describe, it, expect } from "vitest";
import { classSilhouette } from "../src/net/classModels";
import { classList, classLoadout } from "../src/net/roles";

describe("classSilhouette — a distinct, balance-derived look per class (pure)", () => {
  for (const role of ["human", "drone"] as const) {
    it(`${role}: every class has a positive size and its primary weapon`, () => {
      for (const c of classList(role)) {
        const s = classSilhouette(role, c.id);
        expect(s.scale).toBeGreaterThan(0);
        expect(s.bulk).toBeGreaterThan(0);
        expect(s.weapon).toBe(classLoadout(role, c.id)[0]); // held prop = the class primary
      }
    });
  }

  it("soldiers: the heavy is bulkier and bigger than the scout", () => {
    const heavy = classSilhouette("human", "heavy"), scout = classSilhouette("human", "scout");
    expect(heavy.bulk).toBeGreaterThan(scout.bulk);
    expect(heavy.scale).toBeGreaterThan(scout.scale);
    expect(heavy.plates).toBe(true);   // shoulder plates
    expect(scout.plates).toBe(false);
  });

  it("marksman carries a long-barrel scoped rifle; the scout does not", () => {
    expect(classSilhouette("human", "marksman").longBarrel).toBe(true);
    expect(classSilhouette("human", "scout").longBarrel).toBe(false);
  });

  it("drones: the armor drone has MORE rotors and more bulk than the interceptor", () => {
    const armor = classSilhouette("drone", "armor"), inter = classSilhouette("drone", "interceptor");
    expect(armor.rotors).toBeGreaterThan(inter.rotors);   // 6 vs 4
    expect(armor.bulk).toBeGreaterThan(inter.bulk);
    expect(classSilhouette("drone", "artillery").longBarrel).toBe(true); // belly cannon
  });

  it("an unknown class falls back to that side's assault silhouette", () => {
    expect(classSilhouette("human", "bogus").weapon).toBe(classLoadout("human", "assault")[0]);
  });
});
