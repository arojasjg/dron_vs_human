import { describe, it, expect } from "vitest";
import { cullLod } from "../src/gpu/cpu/cullLod";

// box frustum [-5,5]^3 (visible if dot(n,p)+d+radius >= 0)
const boxPlanes = new Float32Array([
  1, 0, 0, 5, -1, 0, 0, 5,
  0, 1, 0, 5, 0, -1, 0, 5,
  0, 0, 1, 5, 0, 0, -1, 5,
]);

describe("cullLod (GPU-driven culling core)", () => {
  it("keeps only instances inside the frustum (compaction)", () => {
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 8, 0, 3, 3, 3, -4.9, 0, 0]);
    const r = cullLod(pos, 5, { planes: boxPlanes, cam: [0, 0, 100], lodNear: 10, lodFar: 25, radius: 0 });
    expect(r.count).toBe(3);
    expect([...r.indices].sort((a, b) => a - b)).toEqual([0, 3, 4]);
  });

  it("assigns LOD by distance to the camera", () => {
    const pos = new Float32Array([0, 0, 4, 0, 0, 0, 4, 0, -4]);
    const r = cullLod(pos, 3, { planes: boxPlanes, cam: [0, 0, 8], lodNear: 5, lodFar: 12, radius: 0 });
    // dists to (0,0,8): p0=4 (LOD0), p1=8 (LOD1), p2=sqrt(16+144)=12.65 (LOD2)
    const lodOf = new Map<number, number>();
    for (let i = 0; i < r.count; i++) lodOf.set(r.indices[i], r.lods[i]);
    expect(lodOf.get(0)).toBe(0);
    expect(lodOf.get(1)).toBe(1);
    expect(lodOf.get(2)).toBe(2);
  });

  it("the radius margin keeps instances that straddle a plane", () => {
    const pos = new Float32Array([5.4, 0, 0]); // just outside x=5, but radius 0.5 keeps it
    expect(cullLod(pos, 1, { planes: boxPlanes, cam: [0, 0, 0], lodNear: 1, lodFar: 2, radius: 0.5 }).count).toBe(1);
    expect(cullLod(pos, 1, { planes: boxPlanes, cam: [0, 0, 0], lodNear: 1, lodFar: 2, radius: 0.0 }).count).toBe(0);
  });
});
