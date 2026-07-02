import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import { VoxelGrid } from "../src/world/voxelGrid";
import { buildBuilding, setWorldSeed, DOOR_TOP } from "../src/build/prefabs";

beforeAll(async () => { await RAPIER.init(); });

const box = (w: RAPIER.World, hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));

/** Isolated door: a floor + a wall at z=1 with an opening `doorTop` voxels tall. Drive a Walker from
 *  in front (z<1) at it; returns whether it reaches the far side (z>1.3) or the lintel stops it. */
function passesDoor(doorTop: number): boolean {
  const V = 0.25, wallTop = 4.5, dt = doorTop * V, zc = 1;
  const physics = new Physics();
  physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
  const walker = new Walker(physics);
  box(physics.world, 4, 0.125, 4, 0, 0.125, 1);                       // floor, top world 0.25
  box(physics.world, 1.5, wallTop / 2, 0.125, -2, wallTop / 2, zc);   // left jamb  x∈[-3.5,-0.5]
  box(physics.world, 1.5, wallTop / 2, 0.125, 2, wallTop / 2, zc);    // right jamb x∈[ 0.5, 3.5]
  box(physics.world, 0.5, (wallTop - dt) / 2, 0.125, 0, (dt + wallTop) / 2, zc); // lintel above the door
  walker.spawn(0, 1.15, 0);                                           // on the floor, facing the door
  for (let i = 0; i < 30; i++) { walker.move(1 / 60, 0, 0, false); physics.world.step(); }
  for (let i = 0; i < 200; i++) { walker.move(1 / 60, 0, 4.5, false); physics.world.step(); }
  return walker.position.z > 1.3;
}

describe("doors — the human must fit through", () => {
  it("a 7-voxel entrance is too low for the human; a 9-voxel one lets it through", () => {
    expect(passesDoor(7)).toBe(false); // reproduces "las puertas muy bajas, los humanos no pueden pasar"
    expect(passesDoor(9)).toBe(true);  // the DOOR_TOP height
  });

  it("real building ground-floor entrances are DOOR_TOP voxels tall", () => {
    setWorldSeed(1);
    const grid = new VoxelGrid();
    const W = 44, D = 44;
    buildBuilding(grid, 0, 0, { W, D, FLOORS: 3 });
    const runFromFloor = (open: (y: number) => boolean) => { let h = 0; for (let y = 1; y <= 20; y++) { if (open(y)) h++; else break; } return h; };
    let maxDoor = 0; // an entrance is an exterior column open from the floor (y=1) up
    for (let x = 1; x < W - 1; x++) {
      maxDoor = Math.max(maxDoor, runFromFloor((y) => !grid.has(x, y, 0)), runFromFloor((y) => !grid.has(x, y, D - 1)));
    }
    for (let z = 1; z < D - 1; z++) {
      maxDoor = Math.max(maxDoor, runFromFloor((y) => !grid.has(0, y, z)), runFromFloor((y) => !grid.has(W - 1, y, z)));
    }
    expect(maxDoor).toBe(DOOR_TOP); // tallest floor-reaching wall opening = an entrance, DOOR_TOP high
  });
});
