import { describe, it, expect } from "vitest";
import { ammoBoxSites, groundClass } from "../src/build/prefabs";

describe("ammoBoxSites — deterministic street pickups", () => {
  it("is deterministic per world seed (multiplayer-safe)", () => {
    expect(ammoBoxSites(12345)).toEqual(ammoBoxSites(12345)); // same seed → identical layout
    expect(ammoBoxSites(99)).not.toEqual(ammoBoxSites(12345)); // different seed → different layout
  });

  it("places every crate on a STREET (never inside a building/plot or off-map)", () => {
    for (const seed of [0, 7, 12345, 4294967295]) // incl. boundary seeds
      for (const s of ammoBoxSites(seed)) expect(groundClass(s.vx, s.vz)).toBe("street");
  });

  it("scatters a healthy number of crates across the map", () => {
    const s = ammoBoxSites(7);
    expect(s.length).toBeGreaterThanOrEqual(20);
    expect(s.length).toBeLessThanOrEqual(100); // ~one per avenue block across the bigger town
  });

  it("keeps them spread out — no duplicate spot, none clustered on top of each other", () => {
    const s = ammoBoxSites(7);
    expect(new Set(s.map((p) => `${p.vx},${p.vz}`)).size).toBe(s.length); // all distinct
    let minD = Infinity;
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++)
        minD = Math.min(minD, Math.hypot(s[i].vx - s[j].vx, s[i].vz - s[j].vz));
    expect(minD).toBeGreaterThan(8); // at least a couple of metres apart
  });
});
