import { describe, it, expect } from "vitest";
import { VoxelGrid, unpackKey } from "../src/world/voxelGrid";
import { buildDefaultScene, setWorldSeed } from "../src/build/prefabs";

// Late-join reconciliation: a joiner builds the PRISTINE seed-world and misses whatever destruction
// already happened. The fix ships the room's `removedSinceGen` diff to the joiner, who replays it.
// This proves the diff mechanism: pristine world + diff == the destroyed world, byte-identical.
describe("late-join grid reconciliation (removedSinceGen diff)", () => {
  it("pristine seed-world + destruction diff == the destroyed world (byte-identical)", () => {
    // Peer that's been playing: build, baseline, then blow away a big region.
    setWorldSeed(12345);
    const played = new VoxelGrid(); buildDefaultScene(played); played.baselineGen();
    for (let x = 10; x < 44; x++) for (let y = 0; y < 16; y++) for (let z = 10; z < 44; z++) played.remove(x, y, z);
    expect(played.removedSinceGen.size).toBeGreaterThan(0);

    // Late joiner: same seed → identical pristine world, then apply the peer's diff.
    setWorldSeed(12345);
    const joiner = new VoxelGrid(); buildDefaultScene(joiner); joiner.baselineGen();
    expect(joiner.cells.size).toBeGreaterThan(played.cells.size); // starts pristine → MORE voxels (the desync)
    for (const k of played.removedSinceGen) { const [x, y, z] = unpackKey(k); joiner.remove(x, y, z); }

    expect(joiner.cells.size).toBe(played.cells.size);
    expect([...joiner.cells.keys()].sort((p, q) => p - q)).toEqual([...played.cells.keys()].sort((p, q) => p - q));
  });

  it("baselineGen() excludes world-gen window/door cuts from the diff", () => {
    setWorldSeed(7);
    const g = new VoxelGrid(); buildDefaultScene(g); // cuts windows/doors via remove()
    g.baselineGen();
    expect(g.removedSinceGen.size).toBe(0); // gen cuts are forgotten → not synced as "destruction"
    const first = g.cells.keys().next().value as number;
    const [x, y, z] = unpackKey(first);
    g.remove(x, y, z);
    expect(g.removedSinceGen.size).toBe(1); // only real post-baseline destruction is tracked
  });
});
