import { describe, it, expect } from "vitest";
import { WEAPONS, roleLoadout, tryFire, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere, bulletFalloff } from "../src/net/weapons";
import { roleMaxHp } from "../src/net/roles";

describe("bullet range falloff + TTK intent", () => {
  it("shotgun punches up close and fades with range; mg is flat; unknown is version-safe 1.0", () => {
    expect(bulletFalloff("shotgun", 3)).toBeGreaterThan(1);   // close buff
    expect(bulletFalloff("shotgun", 3)).toBeGreaterThan(bulletFalloff("shotgun", 20)); // monotonic decrease
    expect(bulletFalloff("shotgun", 20)).toBeGreaterThan(bulletFalloff("shotgun", 40));
    expect(bulletFalloff("shotgun", 40)).toBeLessThan(0.5);   // weak far
    expect(bulletFalloff("mg", 3)).toBe(1);                   // mg flat…
    expect(bulletFalloff("mg", 40)).toBe(1);                  // …at every range
    expect(bulletFalloff("", 10)).toBe(1);                    // untagged (old client) → no change
  });

  it("TTK table pins the niche: shotgun WINS at close range, mg wins at range", () => {
    // effective damage-per-second = playerDmg * falloff / cooldown
    const dps = (w: "mg" | "shotgun", dist: number) => (WEAPONS[w].playerDmg! * bulletFalloff(w, dist)) / WEAPONS[w].cooldown;
    expect(dps("shotgun", 4)).toBeGreaterThan(dps("mg", 4));  // close quarters → shotgun is the answer
    expect(dps("shotgun", 40)).toBeLessThan(dps("mg", 40));   // at range → mg dominates (shotgun's weakness)
  });
});

describe("team weapon loadouts", () => {
  it("drones get FEWER weapons (mg/grenade/kamikaze); humans get mg/shotgun/glauncher/swarm/sniper/smoke", () => {
    expect(roleLoadout("drone")).toEqual(["mg", "grenade", "kamikaze"]);
    expect(roleLoadout("human")).toEqual(["mg", "shotgun", "glauncher", "swarm", "sniper", "smoke"]);
    expect(roleLoadout("drone").length).toBeLessThan(roleLoadout("human").length); // "pocas armas"
    expect(roleLoadout("drone")).toContain("kamikaze");     // drone-only
    expect(roleLoadout("human")).toContain("swarm");        // human-only anti-swarm mini-drones (replaced the net)
    expect(roleLoadout("human")).toContain("sniper");       // human-only precision weapon
    expect(roleLoadout("human")).not.toContain("net");      // the net is DORMANT now (replaced by the swarm)
    expect(roleLoadout("drone")).not.toContain("swarm");
    expect(roleLoadout("drone")).not.toContain("sniper");
    expect(roleLoadout("human")).not.toContain("kamikaze");
  });

  it("every carried weapon has a spec; drone grenades are FEW; the shotgun sprays pellets", () => {
    for (const w of [...roleLoadout("drone"), ...roleLoadout("human")]) {
      const s = WEAPONS[w];
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.magSize).toBeGreaterThan(0);
      expect(s.cooldown).toBeGreaterThanOrEqual(0);
    }
    expect(WEAPONS.grenade.magSize + WEAPONS.grenade.maxReserve).toBeLessThanOrEqual(8); // "pocas" granadas
    expect(WEAPONS.shotgun.pellets!).toBeGreaterThan(1);
  });
});

describe("sniper — scoped, one-shot the drone, slow bolt cadence", () => {
  const s = WEAPONS.sniper;
  it("one clean body hit downs a drone at ANY range (flat damage, no falloff)", () => {
    const droneHp = roleMaxHp("drone");                       // 80
    expect(bulletFalloff("sniper", 3)).toBe(1);               // not the shotgun → flat…
    expect(bulletFalloff("sniper", 90)).toBe(1);              // …at every range
    expect(s.playerDmg! * bulletFalloff("sniper", 3)).toBeGreaterThanOrEqual(droneHp);  // one-shot up close
    expect(s.playerDmg! * bulletFalloff("sniper", 90)).toBeGreaterThanOrEqual(droneHp); // …and far away
  });

  it("is a scoped precision weapon: magnifies, slow cadence, small mag", () => {
    expect(s.scope).toBe(true);
    expect(Math.min(...s.zoomMags!)).toBeGreaterThan(1);      // every stop magnifies (>1× = zoom IN, never out)
    expect(s.fire).toBe("bullet");                            // pinpoint hitscan, no spread
    expect(s.cooldown).toBeGreaterThan(WEAPONS.shotgun.cooldown); // slower than every other bullet weapon
    expect(s.magSize).toBeLessThanOrEqual(6);                 // small magazine
    expect(s.bulletSpeed!).toBeGreaterThan(120);              // the round zips downrange (faster tracer than the MG's default)
    expect(s.boltAction).toBe(true);                          // one shot per trigger pull, then rack the bolt
  });

  it("has TWO zoom levels — ×5 and ×10 — the higher one reaching FARTHER (parallel ranges)", () => {
    expect(s.zoomMags).toEqual([5, 10]);
    expect(s.aiRanges!.length).toBe(s.zoomMags!.length);      // one reach per zoom level
    expect(s.zoomMags![1]).toBeGreaterThan(s.zoomMags![0]);   // level 2 magnifies more
    expect(s.aiRanges![1]).toBeGreaterThan(s.aiRanges![0]);   // …and it reaches farther
  });

  it("is worth carrying in co-op: one-shots a bot (HP 3) at long range", () => {
    expect(s.botDmg!).toBeGreaterThanOrEqual(3);              // a bot has 3 HP → downed in one
    expect(Math.max(...s.aiRanges!)).toBeGreaterThan(30);     // reaches farther than the default MG hitscan
  });
});

describe("class bullet weapons — smg/lmg/dmr with distinct niches", () => {
  it("smg shreds up close but falls off hard past mid-range (monotonic)", () => {
    expect(bulletFalloff("smg", 5)).toBeGreaterThan(1);                          // close buff
    expect(bulletFalloff("smg", 5)).toBeGreaterThan(bulletFalloff("smg", 18));   // monotonic decrease
    expect(bulletFalloff("smg", 18)).toBeGreaterThan(bulletFalloff("smg", 40));
    expect(bulletFalloff("smg", 40)).toBeLessThan(0.5);                          // feeble far
  });

  it("smg wins the close DPS race vs the mg but loses it at range (its weakness)", () => {
    const dps = (w: "mg" | "smg", dist: number) => (WEAPONS[w].playerDmg! * bulletFalloff(w, dist)) / WEAPONS[w].cooldown;
    expect(dps("smg", 4)).toBeGreaterThan(dps("mg", 4));   // close quarters → smg out-DPSes the mg
    expect(dps("smg", 40)).toBeLessThan(dps("mg", 40));    // at range → the mg wins
  });

  it("lmg is the heavy suppressor: big mag + hard-hitting, flat range", () => {
    expect(WEAPONS.lmg.magSize).toBeGreaterThan(WEAPONS.mg.magSize);    // huge magazine
    expect(WEAPONS.lmg.playerDmg!).toBeGreaterThan(WEAPONS.mg.playerDmg!);
    expect(bulletFalloff("lmg", 5)).toBe(1);                            // flat…
    expect(bulletFalloff("lmg", 40)).toBe(1);                          // …at every range
    expect(WEAPONS.lmg.botDmg!).toBeGreaterThanOrEqual(2);
  });

  it("dmr sits between the mg and the sniper: harder-hitting than mg, faster than sniper", () => {
    expect(WEAPONS.dmr.playerDmg!).toBeGreaterThan(WEAPONS.mg.playerDmg!);
    expect(WEAPONS.dmr.playerDmg!).toBeLessThan(WEAPONS.sniper.playerDmg!);
    expect(WEAPONS.dmr.cooldown).toBeGreaterThan(WEAPONS.mg.cooldown);
    expect(WEAPONS.dmr.cooldown).toBeLessThan(WEAPONS.sniper.cooldown);
    expect(WEAPONS.dmr.scope).toBe(true);
    expect(WEAPONS.dmr.boltAction).not.toBe(true);          // semi-auto, not bolt-action
  });

  it("all three route through the bullet path and carry valid specs", () => {
    for (const w of ["smg", "lmg", "dmr"] as const) {
      const s = WEAPONS[w];
      expect(s.fire).toBe("bullet");
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.magSize).toBeGreaterThan(0);
      expect(s.playerDmg!).toBeGreaterThan(0);
    }
  });
});

describe("ammo — limited, auto-reload, base-refilled", () => {
  it("draws the mag, auto-reloads from reserve, then blocks when fully empty", () => {
    let a = { mag: 2, reserve: 3 };
    a = tryFire(a, 2).ammo; expect(a).toEqual({ mag: 1, reserve: 3 });
    a = tryFire(a, 2).ammo; expect(a).toEqual({ mag: 0, reserve: 3 });
    const reload = tryFire(a, 2);
    expect(reload.fired).toBe(true);
    expect(reload.ammo).toEqual({ mag: 1, reserve: 1 });    // pulled a fresh 2-round mag, fired one
    a = tryFire(reload.ammo, 2).ammo;                       // mag 0, reserve 1
    const last = tryFire(a, 2);
    expect(last.ammo).toEqual({ mag: 0, reserve: 0 });      // reloaded the last round and fired it
    expect(tryFire(last.ammo, 2).fired).toBe(false);        // now empty → cannot fire
  });

  it("a full resupply restores the whole mag + reserve (recharge at base)", () => {
    expect(fullAmmo(WEAPONS.mg)).toEqual({ mag: 40, reserve: 200 });
  });
});

describe("bullet-vs-player hit test (rayHitsSphere)", () => {
  const R = 1.0;
  it("registers a hit when the line of fire passes through the player", () => {
    // shooter at origin firing +z; target 5 m down-range, dead centre
    expect(rayHitsSphere(0, 0, 0, 0, 0, 1, 0, 0, 5, 20, R)).toBe(true);
    // slightly off-axis but within the body radius
    expect(rayHitsSphere(0, 0, 0, 0, 0, 1, 0.5, 0, 5, 20, R)).toBe(true);
  });
  it("misses when the shot goes wide, points away, or is blocked short by a wall", () => {
    expect(rayHitsSphere(0, 0, 0, 0, 0, 1, 3, 0, 5, 20, R)).toBe(false);   // 3 m to the side → wide
    expect(rayHitsSphere(0, 0, 0, 0, 0, 1, 0, 0, -5, 20, R)).toBe(false);  // target behind the shooter
    expect(rayHitsSphere(0, 0, 0, 0, 0, 1, 0, 0, 5, 3, R)).toBe(false);    // a wall stops the bullet at 3 m
  });
});

describe("drone battery — drains with movement, fatal at 0", () => {
  it("drains faster the faster/more the drone moves (idle < cruise < boost)", () => {
    expect(batteryDrain(0, 1)).toBeGreaterThan(0);                       // idle still trickles
    expect(batteryDrain(9, 1)).toBeGreaterThan(batteryDrain(0, 1));      // moving > idle
    expect(batteryDrain(20, 1)).toBeGreaterThan(batteryDrain(9, 1));     // boost > cruise
  });

  it("a full charge lasts minutes idling but ~half a minute boosting (never instant)", () => {
    const idleLife = BATTERY_MAX / batteryDrain(0, 1);
    const boostLife = BATTERY_MAX / batteryDrain(20, 1);
    expect(boostLife).toBeLessThan(idleLife);
    expect(boostLife).toBeGreaterThan(20);   // boosting non-stop still gives ~30 s of flight
    expect(idleLife).toBeGreaterThan(120);   // hovering lasts minutes
  });
});
