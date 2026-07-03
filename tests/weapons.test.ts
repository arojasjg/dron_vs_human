import { describe, it, expect } from "vitest";
import { WEAPONS, roleLoadout, tryFire, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere } from "../src/net/weapons";

describe("team weapon loadouts", () => {
  it("drones get FEWER weapons (mg/grenade/kamikaze); humans get mg/shotgun/glauncher/net", () => {
    expect(roleLoadout("drone")).toEqual(["mg", "grenade", "kamikaze"]);
    expect(roleLoadout("human")).toEqual(["mg", "shotgun", "glauncher", "net"]);
    expect(roleLoadout("drone").length).toBeLessThan(roleLoadout("human").length); // "pocas armas"
    expect(roleLoadout("drone")).toContain("kamikaze");     // drone-only
    expect(roleLoadout("human")).toContain("net");          // human-only (catch a drone)
    expect(roleLoadout("drone")).not.toContain("net");
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
