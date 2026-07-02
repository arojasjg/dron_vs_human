import { describe, it, expect } from "vitest";
import { makeGrid } from "../src/gpu/cpu/neighborGrid";
import { pbdSolve } from "../src/gpu/cpu/pbdSolve";

const dist = (p: Float32Array, i: number, j: number) =>
  Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);

describe("pbdSolve", () => {
  const g = makeGrid(1.0, [-10, -10, -10], [20, 20, 20]); // cellSize >= contact distance

  it("separates two overlapping particles to the rest distance (2*radius)", () => {
    const pos = new Float32Array([0, 5, 0, 0.4, 5, 0]); // dist 0.4, rest = 1.0
    pbdSolve(g, pos, 2, { radius: 0.5, iterations: 4, groundY: -100 });
    expect(dist(pos, 0, 1)).toBeCloseTo(1.0, 2);
  });

  it("rests a particle on the ground at y = groundY + radius", () => {
    const pos = new Float32Array([0, -3, 0]);
    pbdSolve(g, pos, 1, { radius: 0.5, iterations: 2, groundY: 0 });
    expect(pos[1]).toBeCloseTo(0.5, 5);
  });

  it("pushes apart a dense clump (bounded penetration, no NaN)", () => {
    const pts: number[] = [];
    for (let x = 0; x < 3; x++)
      for (let y = 0; y < 3; y++)
        for (let z = 0; z < 3; z++) pts.push(x * 0.25, 5 + y * 0.25, z * 0.25); // heavy overlap
    const pos = new Float32Array(pts);
    const n = pts.length / 3;

    let minBefore = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) minBefore = Math.min(minBefore, dist(pos, i, j));

    pbdSolve(g, pos, n, { radius: 0.5, iterations: 30, groundY: -100 });

    let minAfter = Infinity;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) expect(Number.isFinite(pos[i * 3 + k])).toBe(true);
      for (let j = i + 1; j < n; j++) minAfter = Math.min(minAfter, dist(pos, i, j));
    }
    expect(minAfter).toBeGreaterThan(minBefore); // the solver spread them out
    expect(minAfter).toBeGreaterThan(0.5);        // penetration is bounded
  });
});
