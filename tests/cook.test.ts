import { describe, it, expect } from "vitest";
import { greedyBoxesFromKeys, cookColliderBoxes } from "../src/world/cook";
import { packKey } from "../src/world/voxelGrid";

describe("cook — pure greedy-box decomposition (worker-safe)", () => {
  it("cookColliderBoxes flat Int32Array matches greedyBoxesFromKeys box-for-box", () => {
    const keys: number[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) keys.push(packKey(x, y, z));
    const boxes = greedyBoxesFromKeys(keys);
    const flat = cookColliderBoxes(keys);
    expect(flat.length).toBe(boxes.length * 6);
    for (let i = 0; i < boxes.length; i++)
      expect([flat[i * 6], flat[i * 6 + 1], flat[i * 6 + 2], flat[i * 6 + 3], flat[i * 6 + 4], flat[i * 6 + 5]]).toEqual(boxes[i]);
  });

  it("is invariant to key iteration order (deterministic → identical in a worker)", () => {
    const keys: number[] = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) keys.push(packKey(x, y, z));
    const a = cookColliderBoxes(keys);
    const b = cookColliderBoxes([...keys].reverse()); // same SET, opposite order
    expect([...b]).toEqual([...a]);
  });

  it("a solid block cooks to a single box; empty cooks to nothing", () => {
    const keys: number[] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) keys.push(packKey(x, y, z));
    expect(cookColliderBoxes(keys)).toEqual(new Int32Array([0, 0, 0, 3, 3, 3]));
    expect(cookColliderBoxes([]).length).toBe(0);
  });
});
