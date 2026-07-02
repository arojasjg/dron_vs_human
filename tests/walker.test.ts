import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";

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
