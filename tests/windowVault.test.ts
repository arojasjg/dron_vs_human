import { describe, it, expect } from "vitest";
import { windowVault } from "../src/net/windowVault";
import { VOXEL } from "../src/config";

// Build a has() over a voxel Set. Wall plane at x=10, z∈[-3,3]. Caller chooses which y-rows are solid.
function wallGrid(solidRows: number[]) {
  const s = new Set<string>();
  for (const y of solidRows) for (let z = -3; z <= 3; z++) s.add(`10,${y},${z}`);
  return (x: number, y: number, z: number) => s.has(`${x},${y},${z}`);
}

// feet one voxel before the wall (fx=9), on the floor (fy=5), centred (fz=0), facing +x
const FX = 9, FY = 5;
const feet = { x: (FX + 0.4) * VOXEL, y: (FY + 0.4) * VOXEL, z: 0.1 };

describe("windowVault — glassless-window climb detection", () => {
  it("detects a window (solid sill 5,6 · open gap 7,8 · lintel 9,10) and lands past the wall", () => {
    const has = wallGrid([5, 6, 9, 10]); // opening at y=7,8 (fy+2,fy+3)
    const t = windowVault(has, feet.x, feet.y, feet.z, 1, 0);
    expect(t).not.toBeNull();
    expect(t!.x).toBeGreaterThan(10 * VOXEL); // landing is on the FAR side of the wall
    expect(Math.abs(t!.y - feet.y)).toBeLessThan(VOXEL); // same height (a step-through, not a climb up)
  });

  it("returns null for a SOLID wall (no opening at chest height)", () => {
    const has = wallGrid([5, 6, 7, 8, 9, 10]); // filled — no window
    expect(windowVault(has, feet.x, feet.y, feet.z, 1, 0)).toBeNull();
  });

  it("returns null for a DOORWAY (no sill — you just walk in)", () => {
    const has = wallGrid([9, 10]); // empty at foot level (5,6,7,8) → a door, not a window
    expect(windowVault(has, feet.x, feet.y, feet.z, 1, 0)).toBeNull();
  });

  it("returns null when facing AWAY from the wall", () => {
    const has = wallGrid([5, 6, 9, 10]);
    expect(windowVault(has, feet.x, feet.y, feet.z, -1, 0)).toBeNull();
  });

  it("returns null when the far side is blocked (no room to land)", () => {
    const has = (x: number, y: number, z: number) => {
      const s = new Set<string>();
      for (const y2 of [5, 6, 9, 10]) for (let z2 = -3; z2 <= 3; z2++) s.add(`10,${y2},${z2}`);
      for (let x2 = 11; x2 <= 13; x2++) for (let y2 = 4; y2 <= 8; y2++) for (let z2 = -3; z2 <= 3; z2++) s.add(`${x2},${y2},${z2}`); // solid room behind
      return s.has(`${x},${y},${z}`);
    };
    expect(windowVault(has, feet.x, feet.y, feet.z, 1, 0)).toBeNull();
  });
});
