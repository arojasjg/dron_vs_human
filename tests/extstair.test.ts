import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { VoxelGrid } from "../src/world/voxelGrid";
import { VoxelCollider } from "../src/world/voxelCollider";
import { buildBuilding, setWorldSeed } from "../src/build/prefabs";
import { VOXEL } from "../src/config";

beforeAll(async () => { await RAPIER.init(); });

const box = (w: RAPIER.World, hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));

describe("external fire-escape — boardable from the street", () => {
  it("a Walker climbs onto the external ground flight from the street WITHOUT jumping", () => {
    setWorldSeed(1);
    const grid = new VoxelGrid();
    const W = 44, D = 44;
    buildBuilding(grid, 0, 0, { W, D, FLOORS: 3 });
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    new VoxelCollider(physics).rebuildAll(grid);
    box(physics.world, 100, 0.5, 100, 0, -0.5, 0);        // the street, top at world 0
    const walker = new Walker(physics);
    const laneAx = (W + 1) * VOXEL;                        // east fire-escape, near-wall lane centre
    walker.spawn(laneAx, 1.0, -0.6);                      // on the street, well in front of the low tread
    for (let i = 0; i < 30; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); }
    const y0 = walker.position.y;
    let peak = y0;
    for (let i = 0; i < 140; i++) { walker.move(1 / 60, 0, 4.5, false); physics.world.step(); peak = Math.max(peak, walker.position.y); }
    expect(peak).toBeGreaterThan(y0 + 3.5);               // climbed a full flight from the street, no jump
  });
});
