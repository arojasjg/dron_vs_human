import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { VoxelGrid } from "../src/world/voxelGrid";
import { VOXEL } from "../src/config";
import type { Input } from "../src/engine/input";

beforeAll(async () => { await RAPIER.init(); });

const keyInput = (down: string): Input => ({
  locked: false, consumeMouseDelta: () => ({ x: 0, y: 0 }), isDown: (c: string) => c === down,
} as unknown as Input);

function scene() {
  const physics = new Physics();
  physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
  // ground top at y=0.1 so a grounded walker's feet settle inside voxel row 0 (fy=0) — the row the window
  // pattern below is keyed to. (At exactly y=0 the feet float-settle at ≈-0.001 → fy=-1 and the check misses.)
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.4, 0));
  const grid = new VoxelGrid();
  // wall plane at voxel x=10 (world 2.5 m): solid sill (y 0,1) + lintel (y 4,5), OPEN window at y 2,3
  for (const y of [0, 1, 4, 5]) for (let z = -3; z <= 3; z++) grid.set(10, y, z, "brick");
  // physics SILL so the walker is BLOCKED at the wall, as in-game (spans the grounded capsule's lower half)
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.3, 3).setTranslation(2.6, 0.3, 0));
  return { physics, grid };
}

describe("human window-vault + prone", () => {
  it("clambers through a glassless window: enters the climb pose and crosses to the far side", () => {
    const { physics, grid } = scene();
    const walker = new Walker(physics, grid);
    walker.spawn(8 * VOXEL, 0.95, 0.1, Math.PI / 2); // grounded at the window (feet in row 0), facing +x
    let sawClimb = false;
    const input = keyInput("keyw"); // push forward into the window
    for (let i = 0; i < 150; i++) {
      walker.update(1 / 60, input);
      physics.world.step();
      if (walker.stanceVal === 3) sawClimb = true;
    }
    expect(sawClimb).toBe(true);                              // entered the climb (stance 3)
    expect(walker.position.x).toBeGreaterThan(11 * VOXEL);    // ended up on the FAR side of the wall
  });

  it("does NOT vault an ordinary spot (no window ahead) — just stands", () => {
    const { physics, grid } = scene();
    const walker = new Walker(physics, grid);
    walker.spawn(9.4 * VOXEL, 1, 0.1, -Math.PI / 2); // facing AWAY from the window
    let sawClimb = false;
    const input = keyInput("keyw");
    for (let i = 0; i < 60; i++) { walker.update(1 / 60, input); physics.world.step(); if (walker.stanceVal === 3) sawClimb = true; }
    expect(sawClimb).toBe(false);
  });

  it("can lie down at any moment (Z → prone stance)", () => {
    const { physics, grid } = scene();
    const walker = new Walker(physics, grid);
    walker.spawn(0, 1, 0);
    const input = keyInput("keyz");
    for (let i = 0; i < 20; i++) { walker.update(1 / 60, input); physics.world.step(); }
    expect(walker.stanceVal).toBe(2); // prone
  });
});
