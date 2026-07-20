import { describe, it, expect } from "vitest";
import { WEAPONS, roleLoadout, tryFire, reloadMag, reloadDuration, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere, hitZone, HEADSHOT_MULT, bulletFalloff, aiHitDamage, aiShotDamage, botHitRange, TRACER_LIFE, spreadAngle, addBloom, decayBloom, coneSpread } from "../src/net/weapons";
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

describe("reloadDuration — a reload takes TIME (firing locked out meanwhile)", () => {
  it("bolt-action (sniper) racks slower than a default mag weapon (dmr)", () => {
    expect(reloadDuration(WEAPONS.sniper)).toBeGreaterThan(reloadDuration(WEAPONS.dmr));
  });

  it("a huge belt/cell (lmg 100, laser 160) is the slowest tier", () => {
    for (const w of ["mg", "smg", "dmr", "shotgun", "sniper"] as const) {
      expect(reloadDuration(WEAPONS.lmg)).toBeGreaterThan(reloadDuration(WEAPONS[w]));
    }
    expect(reloadDuration(WEAPONS.laser)).toBe(reloadDuration(WEAPONS.lmg));
  });

  it("a small shotgun tube (mag 6) reloads slow-ish — at least as slow as an smg", () => {
    expect(reloadDuration(WEAPONS.shotgun)).toBeGreaterThanOrEqual(reloadDuration(WEAPONS.smg));
  });

  it("an explicit reloadTime override is returned verbatim", () => {
    expect(reloadDuration({ ...WEAPONS.mg, reloadTime: 0.7 })).toBe(0.7);
    expect(reloadDuration({ ...WEAPONS.lmg, reloadTime: 5 })).toBe(5);
  });

  it("every spec — even a non-reloading tool — yields a positive finite duration (never 0/NaN)", () => {
    for (const w of Object.keys(WEAPONS) as (keyof typeof WEAPONS)[]) {
      const d = reloadDuration(WEAPONS[w]);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
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

describe("hitZone — two-zone body/head test (body gate unchanged, head flags the multiplier)", () => {
  const BODY_R = 1.0, HEAD_DY = 0.15, HEAD_R = 0.28; // the tightened PvP tuning game.ts wires (headR 0.4→0.28)
  it("a ray straight at the head center is a headshot", () => {
    // shooter at origin firing +z; target center 5 m down-range; aim at center + headDy
    expect(hitZone(0, HEAD_DY, 0, 0, 0, 1, 0, 0, 5, 20, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: true, head: true });
  });
  it("center-mass aim 0.35 below the head is now a BODY hit, not a headshot (would have procd head at 0.4)", () => {
    // ray at y=-0.20 → 0.35 below the head point (0.15): outside the 0.28 head sphere, inside the 1.0 body
    expect(hitZone(0, -0.20, 0, 0, 0, 1, 0, 0, 5, 20, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: true, head: false });
    // the same ray WAS a headshot under the old generous 0.4 head radius — this is the fidelity we tightened
    expect(hitZone(0, -0.20, 0, 0, 0, 1, 0, 0, 5, 20, BODY_R, HEAD_DY, 0.4)).toEqual({ hit: true, head: true });
  });
  it("a ray 0.3 off the head laterally at close range is a body hit, not a headshot", () => {
    // fired parallel +z at x=0.3, head height: 0.3 lateral > 0.28 head R (miss head) but < 1.0 body R (hit body)
    expect(hitZone(0.3, HEAD_DY, 0, 0, 0, 1, 0, 0, 5, 20, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: true, head: false });
  });
  it("a body hit BELOW the head is a normal hit (no multiplier)", () => {
    // ray passes bodyR*0.6 below center → inside the body, outside the 0.28 head sphere at +0.15
    expect(hitZone(0, -BODY_R * 0.6, 0, 0, 0, 1, 0, 0, 5, 20, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: true, head: false });
  });
  it("a wide miss is {hit:false, head:false}", () => {
    expect(hitZone(0, 0, 0, 0, 0, 1, 3, 0, 5, 20, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: false, head: false });
  });
  it("the body gate is UNCHANGED: any shot rayHitsSphere(bodyR) accepts still registers as hit", () => {
    const shots: [number, number, number][] = [[0, 0, 5], [0.5, 0, 5], [0, -0.9, 5], [0.9, 0.3, 8]];
    for (const [tx, ty, tz] of shots) {
      const old = rayHitsSphere(0, 0, 0, 0, 0, 1, tx, ty, tz, 20, BODY_R);
      expect(hitZone(0, 0, 0, 0, 0, 1, tx, ty, tz, 20, BODY_R, HEAD_DY, HEAD_R).hit).toBe(old);
    }
  });
  it("a wall short of the target blocks both zones, and the multiplier rewards (>1)", () => {
    expect(hitZone(0, HEAD_DY, 0, 0, 0, 1, 0, 0, 5, 3, BODY_R, HEAD_DY, HEAD_R)).toEqual({ hit: false, head: false });
    expect(HEADSHOT_MULT).toBeGreaterThan(1);
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

describe("weapon spread / bloom — auto fire cones out, ADS tightens, sniper stays pinpoint", () => {
  const len = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
  const dot = (a: [number, number, number], b: [number, number, number]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it("coneSpread with angle=0 returns the normalized input", () => {
    expect(coneSpread(0, 0, 2, 0, 0.3, 0.7)).toEqual([0, 0, 1]);
    const [x, y, z] = coneSpread(3, 4, 0, 0, 0.5, 0.5);
    expect(x).toBeCloseTo(0.6, 10); expect(y).toBeCloseTo(0.8, 10); expect(z).toBeCloseTo(0, 10);
  });

  it("coneSpread always returns a UNIT vector, including near-vertical dirs", () => {
    const dirs: [number, number, number][] = [
      [0, 0, 1], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0.001, 0.9999, 0.001], [1, 1, 1], [-2, 0.5, 3],
    ];
    for (const [dx, dy, dz] of dirs) {
      for (const r1 of [0, 0.25, 0.5, 0.99]) for (const r2 of [0, 0.5, 0.99]) {
        const out = coneSpread(dx, dy, dz, 0.05, r1, r2);
        expect(len(out)).toBeCloseTo(1, 6);
      }
    }
  });

  it("coneSpread stays within the cone: dot(input, output) >= cos(angle)", () => {
    for (const angle of [0.005, 0.02, 0.055, 0.09]) {
      for (const [dx, dy, dz] of [[0, 0, 1], [0, 1, 0], [0, -1, 0], [1, 2, -1]] as [number, number, number][]) {
        const l = Math.hypot(dx, dy, dz), unit: [number, number, number] = [dx / l, dy / l, dz / l];
        for (const r1 of [0, 0.2, 0.6, 0.95]) for (const r2 of [0, 0.4, 0.999]) {
          const out = coneSpread(dx, dy, dz, angle, r1, r2);
          expect(dot(unit, out)).toBeGreaterThanOrEqual(Math.cos(angle) - 1e-6);
        }
      }
    }
  });

  it("no-spread weapon (grenade) → spreadAngle/addBloom/decayBloom all 0 (pinpoint path untouched)", () => {
    expect(WEAPONS.grenade.spread).toBeUndefined();
    expect(spreadAngle(WEAPONS.grenade, 0.5, false)).toBe(0);
    expect(addBloom(WEAPONS.grenade, 0.5)).toBe(0);
    expect(decayBloom(WEAPONS.grenade, 0.5, 1)).toBe(0);
  });

  it("addBloom grows by perShot and caps at max", () => {
    const s = WEAPONS.mg.spread!;
    expect(addBloom(WEAPONS.mg, 0)).toBeCloseTo(s.perShot, 10);
    let b = 0;
    for (let i = 0; i < 100; i++) b = addBloom(WEAPONS.mg, b);
    expect(b).toBe(s.max);                                    // capped after sustained fire
    expect(addBloom(WEAPONS.mg, s.max)).toBe(s.max);          // never exceeds max
  });

  it("decayBloom reduces by decay*dt and floors at 0", () => {
    const s = WEAPONS.mg.spread!;
    expect(decayBloom(WEAPONS.mg, 0.05, 0.1)).toBeCloseTo(0.05 - s.decay * 0.1, 10);
    expect(decayBloom(WEAPONS.mg, 0.01, 100)).toBe(0);        // long pause → fully settled
    expect(decayBloom(WEAPONS.mg, 0.02, -5)).toBe(0.02);      // negative dt never grows bloom
  });

  it("aiming down sights tightens the cone; sniper is pinpoint even at full bloom", () => {
    expect(spreadAngle(WEAPONS.mg, 0.03, true)).toBeLessThan(spreadAngle(WEAPONS.mg, 0.03, false));
    expect(spreadAngle(WEAPONS.mg, 0, false)).toBeGreaterThan(0);           // hip fire never laser-accurate
    expect(spreadAngle(WEAPONS.sniper, 0, true)).toBe(0);                   // sniper stays a precision one-shot
    expect(spreadAngle(WEAPONS.sniper, 0, false)).toBe(0);
    expect(addBloom(WEAPONS.sniper, 0)).toBe(0);                            // and never accumulates bloom
  });

  it("every auto bullet weapon has spread; bloom makes sustained fire measurably wider", () => {
    for (const w of ["mg", "smg", "lmg", "laser", "dmr"] as const) {
      const s = WEAPONS[w].spread!;
      expect(s.base).toBeGreaterThan(0);
      expect(s.max).toBeGreaterThanOrEqual(s.base);
      expect(spreadAngle(WEAPONS[w], s.max, false)).toBeGreaterThan(spreadAngle(WEAPONS[w], 0, false));
    }
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
