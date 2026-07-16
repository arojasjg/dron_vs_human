import { describe, it, expect } from "vitest";
import { WEAPON_SFX, explosionParams, IMPACT_SFX, distanceGain } from "../src/fx/soundParams";

describe("weapon shot params", () => {
  it("the shotgun is louder, lower and longer than the machine-gun", () => {
    expect(WEAPON_SFX.shotgun.gain).toBeGreaterThan(WEAPON_SFX.mg.gain);
    expect(WEAPON_SFX.shotgun.bodyFreq).toBeLessThan(WEAPON_SFX.mg.bodyFreq);
    expect(WEAPON_SFX.shotgun.decay).toBeGreaterThan(WEAPON_SFX.mg.decay);
  });
  it("every carried weapon has a shot profile", () => {
    for (const w of ["mg", "smg", "lmg", "dmr", "sniper", "shotgun", "grenade", "glauncher", "net"]) {
      expect(WEAPON_SFX[w].gain).toBeGreaterThan(0);
      expect(WEAPON_SFX[w].decay).toBeGreaterThan(0);
    }
  });
  it("smg / lmg / dmr each sound DISTINCT (no more clones of the machine-gun)", () => {
    const { mg, smg, lmg, dmr } = WEAPON_SFX;
    // smg: faster + higher + lighter than the mg
    expect(smg.decay).toBeLessThan(mg.decay);
    expect(smg.crackFreq).toBeGreaterThan(mg.crackFreq);
    expect(smg.gain).toBeLessThan(mg.gain);
    // lmg: heavier — lower crack, longer, louder
    expect(lmg.crackFreq).toBeLessThan(mg.crackFreq);
    expect(lmg.decay).toBeGreaterThan(mg.decay);
    expect(lmg.gain).toBeGreaterThan(mg.gain);
    // dmr: marksman punch — deepest body, longest of the three, loudest
    expect(dmr.bodyFreq).toBeLessThan(mg.bodyFreq);
    expect(dmr.decay).toBeGreaterThan(lmg.decay);
    expect(dmr.gain).toBeGreaterThan(lmg.gain);
    // no two of the four share an identical full profile
    const key = (s: typeof mg) => `${s.crackFreq}-${s.bodyFreq}-${s.decay}-${s.gain}`;
    expect(new Set([mg, smg, lmg, dmr].map(key)).size).toBe(4);
  });
});

describe("explosion params scale with power", () => {
  it("a bigger blast is louder, longer and lower, clamped at the extremes", () => {
    const grenade = explosionParams(360), rocket = explosionParams(520), kamikaze = explosionParams(900);
    expect(kamikaze.decay).toBeGreaterThan(rocket.decay);
    expect(rocket.decay).toBeGreaterThan(grenade.decay);
    expect(kamikaze.subFreq).toBeLessThan(grenade.subFreq);          // bigger → deeper sub
    expect(explosionParams(1e6).gain).toBeLessThanOrEqual(1);        // clamped
    expect(explosionParams(0).decay).toBeGreaterThan(0);
  });
});

describe("material impact params", () => {
  it("glass and metal ring; concrete is a dull low thud", () => {
    expect(IMPACT_SFX.glass.ring).toBe(true);
    expect(IMPACT_SFX.metal.ring).toBe(true);
    expect(IMPACT_SFX.concrete.ring).toBe(false);
    expect(IMPACT_SFX.glass.freq).toBeGreaterThan(IMPACT_SFX.concrete.freq); // brighter
    expect(IMPACT_SFX.concrete.filter).toBe("lowpass");
    expect(IMPACT_SFX.metal.decay).toBeGreaterThan(IMPACT_SFX.concrete.decay); // longer ring
  });
});

describe("distance falloff", () => {
  it("is full at the ear and fades toward zero with distance, clamped", () => {
    expect(distanceGain(0)).toBeCloseTo(1);
    expect(distanceGain(28)).toBeCloseTo(0.5);
    expect(distanceGain(1000)).toBeLessThan(0.05);
    expect(distanceGain(-5)).toBeLessThanOrEqual(1);
    expect(distanceGain(1000)).toBeGreaterThanOrEqual(0);
  });
});
