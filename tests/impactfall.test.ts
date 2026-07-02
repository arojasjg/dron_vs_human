import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { Player } from "../src/engine/player";
import { humanFallDamage, droneImpactDamage } from "../src/engine/falldamage";
import type { Input } from "../src/engine/input";

beforeAll(async () => { await RAPIER.init(); });

const box = (w: RAPIER.World, hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));

describe("fall & impact damage — integrated with the controllers", () => {
  it("a Walker dropped 4 storeys registers a fall that deals damage", () => {
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    const walker = new Walker(physics);
    box(physics.world, 20, 0.5, 20, 0, -0.5, 0);          // ground, top y=0
    walker.spawn(0, 4 * 4.75, 0);                          // 4 storeys up (19 m)
    let fall = 0;
    for (let i = 0; i < 500; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); fall = Math.max(fall, walker.takeFall()); }
    expect(fall).toBeGreaterThan(3 * 4.75);                // recorded a >3-storey fall
    expect(humanFallDamage(fall)).toBeGreaterThan(0);      // …which deals damage
  });

  it("a short hop registers NO damaging fall", () => {
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    const walker = new Walker(physics);
    box(physics.world, 20, 0.5, 20, 0, -0.5, 0);
    walker.spawn(0, 4.75, 0);                              // ~1 storey (below the safe limit)
    let fall = 0;
    for (let i = 0; i < 500; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); fall = Math.max(fall, walker.takeFall()); }
    expect(humanFallDamage(fall)).toBe(0);                 // ≤ 1 storey → harmless
  });

  it("a drone boosting into a wall takes impact damage; drifting into it does not", () => {
    const wall = (physics: Physics) => box(physics.world, 5, 5, 0.5, 0, 1, 5); // wall at z≈4.5
    const run = (boost: boolean): number => {
      const physics = new Physics();
      physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
      const player = new Player(physics);
      wall(physics);
      player.spawn(0, 1, 0);
      const input = { locked: false, consumeMouseDelta: () => ({ x: 0, y: 0 }),
        isDown: (c: string) => c === "keyw" || (boost && (c === "shiftleft")) } as unknown as Input;
      let maxDmg = 0;
      for (let i = 0; i < 150; i++) { player.update(1 / 60, input); physics.world.step(); const im = player.takeImpact(); maxDmg = Math.max(maxDmg, droneImpactDamage(im.speed, im.blocked)); }
      return maxDmg;
    };
    expect(run(true)).toBeGreaterThan(0);  // boosting (20 m/s) into the wall hurts
    expect(run(false)).toBe(0);            // cruising (9 m/s) into the wall is harmless
  });
});
