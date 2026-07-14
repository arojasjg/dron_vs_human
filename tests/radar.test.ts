import { describe, it, expect } from "vitest";
import { wrapAngle, bearing, toRadar, compassMarks, COMPASS } from "../src/ui/radar";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("radar/minimap math (pure, heading-up)", () => {
  it("wrapAngle folds to (-π, π]", () => {
    expect(near(wrapAngle(0), 0)).toBe(true);
    expect(near(wrapAngle(Math.PI * 3), Math.PI)).toBe(true);
    expect(near(wrapAngle(-Math.PI * 3), Math.PI)).toBe(true);
    expect(near(wrapAngle(Math.PI * 2 + 0.5), 0.5)).toBe(true);
  });

  it("bearing is 0 straight ahead, ±π behind, +right / −left (heading-up)", () => {
    // viewer at origin facing +Z (heading 0)
    expect(near(bearing(0, 0, 0, 0, 10), 0)).toBe(true);          // target ahead (+Z)
    expect(Math.abs(bearing(0, 0, 0, 0, -10))).toBeCloseTo(Math.PI); // behind (−Z)
    expect(bearing(0, 0, 0, 10, 0)).toBeCloseTo(Math.PI / 2);     // to the right (+X)
    expect(bearing(0, 0, 0, -10, 0)).toBeCloseTo(-Math.PI / 2);   // to the left (−X)
    // facing +X (heading π/2): a target at +X is now straight ahead
    expect(near(bearing(Math.PI / 2, 0, 0, 10, 0), 0)).toBe(true);
  });

  it("toRadar puts an entity ahead at top-centre, and returns null beyond range", () => {
    const size = 100, range = 50;
    const ahead = toRadar(0, 0, 0, 0, 25, range, size)!; // halfway, straight ahead
    expect(ahead[0]).toBeCloseTo(50);      // centred horizontally
    expect(ahead[1]).toBeCloseTo(25);      // halfway UP from the centre (50 - 25)
    const right = toRadar(0, 0, 0, 50, 0, range, size)!; // full range to the right
    expect(right[0]).toBeCloseTo(100);     // right edge
    expect(right[1]).toBeCloseTo(50);      // vertically centred
    expect(toRadar(0, 0, 0, 0, 999, range, size)).toBeNull(); // beyond range → nothing
  });

  it("heading-up rotates the map: facing +X, an entity to your +X reads as ahead (top)", () => {
    const p = toRadar(Math.PI / 2, 0, 0, 30, 0, 50, 100)!;
    expect(p[0]).toBeCloseTo(50);          // top-centre (ahead), not to the side
    expect(p[1]).toBeLessThan(50);
  });
});

describe("compass marks (N/S/E/O around the heading-up minimap, pure)", () => {
  const at = (label: string, heading: number, size = 100) => compassMarks(heading, size).find((m) => m.label === label)!;

  it("has the four cardinals with N opposite S and E opposite O", () => {
    expect(COMPASS.map((c) => c.label).sort()).toEqual(["E", "N", "O", "S"]);
    // bearings: N and S differ by π; E and O differ by π
    const b = (l: string) => COMPASS.find((c) => c.label === l)!.bearing;
    expect(Math.abs(wrapAngle(b("N") - b("S")))).toBeCloseTo(Math.PI);
    expect(Math.abs(wrapAngle(b("E") - b("O")))).toBeCloseTo(Math.PI);
  });

  it("all four letters sit on the ring, inside the minimap circle", () => {
    for (const m of compassMarks(0.7, 100)) {
      const d = Math.hypot(m.x - 50, m.y - 50);
      expect(d).toBeGreaterThan(20);  // near the edge, not the centre
      expect(d).toBeLessThan(50);     // inside the circle radius
    }
  });

  it("facing +Z (heading 0): S is at the top, N at the bottom, E right, O left", () => {
    expect(at("S", 0).y).toBeLessThan(50);   // +Z is ahead → South (=+Z) reads up
    expect(at("N", 0).y).toBeGreaterThan(50); // North (−Z) is behind → down
    expect(at("E", 0).x).toBeGreaterThan(50); // +X to the right
    expect(at("O", 0).x).toBeLessThan(50);    // −X to the left
    expect(at("N", 0).x).toBeCloseTo(50);     // N/S centred horizontally
  });

  it("rotates with the heading: facing north (−Z), N swings to the top", () => {
    expect(at("N", Math.PI).y).toBeLessThan(50); // now facing north → N is up
    expect(at("S", Math.PI).y).toBeGreaterThan(50);
  });
});
