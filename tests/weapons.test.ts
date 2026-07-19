import { describe, it, expect } from "vitest";
import { WEAPONS, roleLoadout, tryFire, reloadMag, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere, bulletFalloff, aiHitDamage, aiShotDamage, botHitRange, TRACER_LIFE } from "../src/net/weapons";
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

  it("reloadMag: a tactical swap WASTES the partial mag (rounds left in it are lost)", () => {
    const r = reloadMag({ mag: 12, reserve: 30 }, 40);        // reload a 12/40 mag with 30 in reserve
    expect(r.ammo).toEqual({ mag: 30, reserve: 0 });          // fresh mag = min(40,30)=30; the 12 leftover are GONE
    expect(r.lost).toBe(12);                                  // reported for the HUD
    expect(fullReloadNoWaste()).toBe(true);
    function fullReloadNoWaste() {                            // reloading a FULL mag still costs the leftover if forced, but the UI gates it
      const full = reloadMag({ mag: 5, reserve: 0 }, 5);      // empty reserve → no-op, keep the mag
      return full.ammo.mag === 5 && full.lost === 0;
    }
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

describe("AI chip shots — the emitted aim decides the hit, with range falloff", () => {
  const BODY_R = 1.1; // forgiving body radius used by aiShoot
  it("a shot aimed at the target's body hits; one offset past the body radius at range misses", () => {
    // bot at (0,5,0) firing straight +z at a target 30 m down-range, dead centre → hit
    expect(rayHitsSphere(0, 5, 0, 0, 0, 1, 0, 5, 30, 30 + BODY_R, BODY_R)).toBe(true);
    // slightly off-centre but still inside the body radius → hit
    expect(rayHitsSphere(0, 5, 0, 0, 0, 1, 0.8, 5, 10, 10 + BODY_R, BODY_R)).toBe(true);
    // spread jitter of 0.1 sideways puts the ray ~3 m off the body at 30 m → dodged
    const l = Math.hypot(0.1, 1);
    expect(rayHitsSphere(0, 5, 0, 0.1 / l, 0, 1 / l, 0, 5, 30, 30 + BODY_R, BODY_R)).toBe(false);
  });
  it("damage is full up close, tapers with range, and never rounds to 0 in range", () => {
    expect(aiHitDamage(4, 3)).toBe(4);                                // point-blank = base
    expect(aiHitDamage(4, 20)).toBe(4);                               // full out to 20 m
    expect(aiHitDamage(4, 40)).toBeLessThan(4);                       // tapering…
    expect(aiHitDamage(4, 40)).toBeGreaterThan(aiHitDamage(4, 60));   // …monotonically
    expect(aiHitDamage(4, 60)).toBe(2);                               // 50% at 60 m
    expect(aiHitDamage(4, 200)).toBe(2);                              // clamped beyond
    expect(Math.round(aiHitDamage(1, 500))).toBeGreaterThanOrEqual(1); // a landed hit always chips
  });
  it("aiShotDamage fuses the LOS gate, the ray test and falloff into the one decision game.ts wires", () => {
    // dead-on shot (bot at 0,5,0 firing +z), target 3 m down-range, sees=true → full base damage
    expect(aiShotDamage(0, 5, 0, 0, 0, 1, 0, 5, 3, true)).toBe(4);
    // same geometry at 60 m → 50% falloff
    expect(aiShotDamage(0, 5, 0, 0, 0, 1, 0, 5, 60, true)).toBe(2);
    // blind gate: even a perfect shot deals 0 when the bot can't see (sees=false)
    expect(aiShotDamage(0, 5, 0, 0, 0, 1, 0, 5, 3, false)).toBe(0);
    // spread jitter (0.1 off) makes the ray miss the body at 30 m → 0, so strafing dodges
    const l = Math.hypot(0.1, 1);
    expect(aiShotDamage(0, 5, 0, 0.1 / l, 0, 1 / l, 0, 5, 30, true)).toBe(0);
    // target behind the shooter (aim +z, target at -z) → no hit
    expect(aiShotDamage(0, 5, 0, 0, 0, 1, 0, 5, -20, true)).toBe(0);
  });
});

describe("botHitRange — bot damage reach matches what the tracer shows", () => {
  it("a non-scoped weapon's hip-fire reach = tracer travel (bulletSpeed × TRACER_LIFE), far past the old 30 m", () => {
    expect(botHitRange(WEAPONS.mg, false, 0)).toBe((WEAPONS.mg.bulletSpeed ?? 120) * TRACER_LIFE); // = 180 for mg
    expect(botHitRange(WEAPONS.mg, false, 0)).toBe(180);
    expect(botHitRange(WEAPONS.mg, false, 0)).toBeGreaterThan(30);    // the old hardcoded 30 read as broken hit reg
    expect(botHitRange(WEAPONS.smg, false, 0)).toBe(180);
    expect(botHitRange(WEAPONS.lmg, false, 0)).toBe(180);
    expect(botHitRange(WEAPONS.laser, false, 0)).toBe(400 * TRACER_LIFE); // = 600
  });

  it("a scoped weapon uses its per-zoom aiRanges when scoped (clamped) and stays SHORT from the hip", () => {
    expect(botHitRange(WEAPONS.sniper, true, 0)).toBe(70);            // aiRanges[0]
    expect(botHitRange(WEAPONS.sniper, true, 1)).toBe(110);           // aiRanges[1]
    expect(botHitRange(WEAPONS.sniper, true, 5)).toBe(110);           // higher zoom clamps to the last range
    expect(botHitRange(WEAPONS.sniper, false, 0)).toBe(40);           // hip-fire deliberately short — the scope IS its range
    expect(botHitRange(WEAPONS.dmr, true, 0)).toBe(55);               // aiRanges[0]
    expect(botHitRange(WEAPONS.dmr, false, 0)).toBe(40);
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
