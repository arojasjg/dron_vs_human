import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { HUMAN_FOV } from "../src/engine/cameraFeel";
import type { Input } from "../src/engine/input";

beforeAll(async () => { await RAPIER.init(); });

function setup() {
  const physics = new Physics();
  physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0; // no aero noise on the test
  const walker = new Walker(physics);
  const ground = () => physics.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
  const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));
  const run = (steps: number, vx: number, vz: number, jump = false) => {
    for (let i = 0; i < steps; i++) { walker.move(1 / 60, vx, vz, jump); physics.world.step(); }
  };
  return { physics, walker, ground, box, run };
}

describe("Walker — gravity, collision, stairs", () => {
  it("falls under gravity and lands on the floor", () => {
    const { walker, ground, run } = setup();
    ground();
    walker.spawn(0, 3, 0);
    run(180, 0, 0);
    expect(walker.isGrounded).toBe(true);
    expect(walker.position.y).toBeGreaterThan(0.6); // resting on top of the capsule (~0.85), not sunk
    expect(walker.position.y).toBeLessThan(1.2);
  });

  it("is blocked by a wall — it can't walk through voxels", () => {
    const { walker, ground, box, run } = setup();
    ground();
    box(0.25, 3, 3, 2, 1, 0); // wall, near face at x = 1.75
    walker.spawn(0, 0.85, 0);
    run(10, 0, 0);       // settle
    run(150, 4.5, 0);    // charge the wall
    expect(walker.position.x).toBeGreaterThan(0.5); // it did move toward the wall
    expect(walker.position.x).toBeLessThan(1.6);    // but the wall stopped it (didn't pass ~1.45)
  });

  it("jumps on a fresh press", () => {
    const { physics, walker, ground, run } = setup();
    ground();
    walker.spawn(0, 0.85, 0);
    run(30, 0, 0);
    const yRest = walker.position.y;
    expect(walker.isGrounded).toBe(true);
    let peak = yRest;
    for (let i = 0; i < 40; i++) { walker.move(1 / 60, 0, 0, true); physics.world.step(); peak = Math.max(peak, walker.position.y); }
    expect(peak).toBeGreaterThan(yRest + 0.3); // jumped clearly off the ground
  });

  it("does not bunny-hop while the jump key is held through a landing", () => {
    const { walker, ground, run } = setup();
    ground();
    walker.spawn(0, 0.85, 0);
    run(10, 0, 0);
    run(120, 0, 0, true); // hold jump across the whole arc + landing + extra frames
    expect(walker.isGrounded).toBe(true); // landed and STAYED down (no auto re-jump)
  });

  it("is sealed by the playable boundary — a running roof-jump can't escape the map", () => {
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    const bounds = { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
    const ground = () => physics.world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0));

    // WITH bounds: charge east at run speed, holding jump, for 3 s → stays inside the box (clamped near maxX).
    const sealed = new Walker(physics, undefined, bounds);
    ground();
    sealed.spawn(0, 0.85, 0);
    for (let i = 0; i < 200; i++) { sealed.move(1 / 60, 7.5, 0, true); physics.world.step(); }
    expect(sealed.position.x).toBeGreaterThan(1);   // it did travel to the edge
    expect(sealed.position.x).toBeLessThan(2);       // but never crossed maxX (radius-inset ≈ 1.7)

    // CONTROL: the SAME charge with no bounds sails far past — proving the clamp (not friction) is the seal.
    const physics2 = new Physics();
    physics2.wind.x = 0; physics2.wind.y = 0; physics2.wind.z = 0;
    physics2.world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0));
    const free = new Walker(physics2);
    free.spawn(0, 0.85, 0);
    for (let i = 0; i < 200; i++) { free.move(1 / 60, 7.5, 0, true); physics2.world.step(); }
    expect(free.position.x).toBeGreaterThan(5);      // unconfined → way past the box
  });

  it("climbs a step (autostep → can take the stairs)", () => {
    const { walker, ground, box, run } = setup();
    ground();
    box(10, 0.125, 3, 11, 0.125, 0); // a raised floor (top y = 0.25) spanning x∈[1,21]
    walker.spawn(0, 0.85, 0);
    run(10, 0, 0);
    const y0 = walker.position.y;
    run(120, 3, 0); // walk up onto the raised floor and along it
    expect(walker.position.x).toBeGreaterThan(2);            // climbed on and kept going
    expect(walker.position.y).toBeGreaterThan(y0 + 0.15);    // autostep lifted it up the 0.25 m step
  });
});

describe("Walker — per-class movement mods (setClassMods)", () => {
  // a held-forward input at run speed, so update() drives the class-scaled speed
  const fwd = { locked: true, consumeMouseDelta: () => ({ x: 0, y: 0 }), isDown: (k: string) => k === "keyw" } as unknown as Input;

  it("a scout (higher speedMul) travels farther than a heavy (lower) over the same time", () => {
    const dist = (speedMul: number) => {
      const physics = new Physics();
      physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0));
      const w = new Walker(physics);
      w.setClassMods(speedMul, 1);
      w.spawn(0, 0.85, 0);
      for (let i = 0; i < 120; i++) { w.update(1 / 60, fwd); physics.world.step(); }
      const p = w.position; return Math.hypot(p.x, p.z);
    };
    const scout = dist(1.35), heavy = dist(0.70), base = dist(1.0);
    expect(scout).toBeGreaterThan(base);
    expect(base).toBeGreaterThan(heavy);
  });

  it("suppresses movement while the pointer is UNLOCKED (a menu/panel is open)", () => {
    const fwdUnlocked = { locked: false, consumeMouseDelta: () => ({ x: 0, y: 0 }), isDown: (k: string) => k === "keyw" } as unknown as Input;
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0));
    const w = new Walker(physics);
    w.spawn(0, 0.85, 0);
    const p0 = w.position;
    for (let i = 0; i < 120; i++) { w.update(1 / 60, fwdUnlocked); physics.world.step(); }
    const p = w.position;
    expect(Math.hypot(p.x - p0.x, p.z - p0.z)).toBeLessThan(0.05);
  });

  it("jumpMul scales the jump; the default (1) still clears the 0.3 m bar", () => {
    const peak = (jumpMul: number) => {
      const physics = new Physics();
      physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
      const w = new Walker(physics);
      w.setClassMods(1, jumpMul);
      w.spawn(0, 0.85, 0);
      for (let i = 0; i < 20; i++) { w.move(1 / 60, 0, 0, false); physics.world.step(); }
      const rest = w.position.y; let pk = rest;
      for (let i = 0; i < 45; i++) { w.move(1 / 60, 0, 0, true); physics.world.step(); pk = Math.max(pk, w.position.y); }
      return pk - rest;
    };
    expect(peak(1.0)).toBeGreaterThan(0.3);          // default jump unchanged
    expect(peak(1.15)).toBeGreaterThan(peak(1.0));   // scout hops higher
    expect(peak(0.80)).toBeLessThan(peak(1.0));      // heavy hops lower
  });
});

describe("Walker — aim-down-sights (scope)", () => {
  const idle = { locked: false, consumeMouseDelta: () => ({ x: 0, y: 0 }), isDown: () => false } as unknown as Input;
  const flick = (dx: number) => ({ locked: true, consumeMouseDelta: () => ({ x: dx, y: 0 }), isDown: () => false } as unknown as Input);

  it("is an OPTICAL scope: aiming toggles the state but does NOT change the main camera FOV (periphery stays 1x)", () => {
    const physics = new Physics();
    const walker = new Walker(physics);
    walker.spawn(0, 0.85, 0);
    expect(walker.aiming).toBe(false);
    expect(walker.camera.fov).toBeCloseTo(HUMAN_FOV);

    walker.setAds(20);                                      // scope in (the zoom is rendered in the scope circle)
    for (let i = 0; i < 30; i++) walker.update(1 / 60, idle);
    expect(walker.aiming).toBe(true);
    expect(walker.camera.fov).toBeCloseTo(HUMAN_FOV);       // main view is UNZOOMED — the periphery isn't magnified

    walker.setAds(null);                                   // release
    expect(walker.aiming).toBe(false);
    expect(walker.camera.fov).toBeCloseTo(HUMAN_FOV);
  });

  it("steadies the aim: the SAME mouse flick turns you far less while scoped", () => {
    const physics = new Physics();
    const walker = new Walker(physics);
    walker.spawn(0, 0.85, 0);
    const y0 = walker.lookYaw; walker.update(1 / 60, flick(100));
    const hipTurn = Math.abs(walker.lookYaw - y0);           // hip-fire flick

    walker.setAds(30);
    for (let i = 0; i < 60; i++) walker.update(1 / 60, idle); // settle fully zoomed
    const y1 = walker.lookYaw; walker.update(1 / 60, flick(100));
    const adsTurn = Math.abs(walker.lookYaw - y1);           // same flick, scoped

    expect(hipTurn).toBeGreaterThan(0);
    expect(adsTurn).toBeLessThan(hipTurn * 0.6);             // scoped aim is much steadier
  });
});
