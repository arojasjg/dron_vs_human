import { describe, it, expect } from "vitest";
import { MODEL_CONFIGS, selectGltfBots } from "../src/net/avatarModels";

describe("avatar model registry", () => {
  it("every config has a real url, a positive scale and an idle clip", () => {
    for (const cfg of Object.values(MODEL_CONFIGS)) {
      expect(cfg.url.endsWith(".glb")).toBe(true);
      expect(cfg.scale).toBeGreaterThan(0);
      expect(cfg.clips.idle.length).toBeGreaterThan(0);
      expect(Number.isFinite(cfg.yOffset)).toBe(true);
      expect(Number.isFinite(cfg.rot)).toBe(true);
    }
  });
});

describe("selectGltfBots — bounded skinned-mesh LOD (pure)", () => {
  const grid = (ids: number[], spacing = 10) => ids.map((id) => ({ id, x: id * spacing, z: 0 }));

  it("picks only the NEAREST n bots within radius r", () => {
    const bots = grid([1, 2, 3, 4, 5]); // at x = 10,20,30,40,50
    const sel = selectGltfBots(0, 0, bots, 2, 100);
    expect(sel.size).toBe(2);
    expect(sel.has(1)).toBe(true);   // nearest
    expect(sel.has(2)).toBe(true);
    expect(sel.has(5)).toBe(false);  // farthest excluded
  });

  it("excludes bots beyond r entirely", () => {
    const bots = grid([1, 2, 3], 30); // x = 30,60,90
    const sel = selectGltfBots(0, 0, bots, 12, 40); // only x=30 within 40 m
    expect(sel.size).toBe(1);
    expect(sel.has(1)).toBe(true);
  });

  it("caps at n even with hundreds of bots (perf guard)", () => {
    const bots = Array.from({ length: 500 }, (_, i) => ({ id: i, x: (i % 8), z: 0 })); // all clustered, all near
    expect(selectGltfBots(0, 0, bots, 12, 40).size).toBe(12);
  });

  it("is deterministic on ties (id tiebreak → no swap thrash)", () => {
    const bots = [{ id: 7, x: 5, z: 0 }, { id: 3, x: 5, z: 0 }, { id: 9, x: 5, z: 0 }]; // same distance
    const a = [...selectGltfBots(0, 0, bots, 2, 40)].sort((x, y) => x - y);
    const b = [...selectGltfBots(0, 0, bots, 2, 40)].sort((x, y) => x - y);
    expect(a).toEqual(b);
    expect(a).toEqual([3, 7]); // lowest ids win the tie, stably
  });

  it("returns an empty set when nothing is in range", () => {
    expect(selectGltfBots(0, 0, grid([1, 2], 100), 12, 40).size).toBe(0);
    expect(selectGltfBots(0, 0, [], 12, 40).size).toBe(0);
  });
});
