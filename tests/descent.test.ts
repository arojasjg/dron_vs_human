import { describe, it, expect, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Physics } from "../src/engine/physics";
import { Walker } from "../src/engine/walker";
import type { Input } from "../src/engine/input";

beforeAll(async () => { await RAPIER.init(); });

const box = (w: RAPIER.World, hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z));
const mockInput = (walk: boolean): Input =>
  ({ locked: true, consumeMouseDelta: () => ({ x: 0, y: 0 }), isDown: (c: string) => walk && c === "keyw" } as unknown as Input);

describe("walker descent — smooth camera, no false fall", () => {
  it("the camera glides down the stairs while the body steps, and no fall is registered", () => {
    const physics = new Physics();
    physics.wind.x = 0; physics.wind.y = 0; physics.wind.z = 0;
    const walker = new Walker(physics);
    box(physics.world, 2, 4.75 / 2, 1.2, 0, 4.75 / 2, -1.2);          // top landing, top y=4.75
    for (let i = 0; i < 19; i++) { const top = (19 - i) * 0.25; box(physics.world, 1.5, top / 2, 0.125, 0, top / 2, i * 0.25); }
    box(physics.world, 2, 0.125, 2, 0, 0.125, 6);                     // bottom landing
    walker.spawn(0, 5.65, -0.8);
    for (let i = 0; i < 30; i++) { walker.update(1 / 60, mockInput(false)); physics.world.step(); } // settle
    walker.takeFall();                                                // clear any settle drop
    let prevCam = walker.camera.position.y, prevBody = walker.position.y;
    let maxCamJump = 0, maxBodyJump = 0, maxFall = 0;
    const walk = mockInput(true);
    for (let i = 0; i < 130; i++) {
      walker.update(1 / 60, walk); physics.world.step();
      maxCamJump = Math.max(maxCamJump, Math.abs(prevCam - walker.camera.position.y));
      maxBodyJump = Math.max(maxBodyJump, Math.abs(prevBody - walker.position.y));
      maxFall = Math.max(maxFall, walker.takeFall());
      prevCam = walker.camera.position.y; prevBody = walker.position.y;
    }
    console.log(`maxCamJump=${maxCamJump.toFixed(3)} maxBodyJump=${maxBodyJump.toFixed(3)} maxFall=${maxFall.toFixed(3)}`);
    expect(maxBodyJump).toBeGreaterThan(0.12);   // the body genuinely steps (lurches) down the stairs
    expect(maxCamJump).toBeLessThan(maxBodyJump); // …but the camera glides (smoothed), no visual jumps
    expect(maxFall).toBeLessThan(1.0);            // a normal stair descent registers NO fall (< one storey)
  });
});
