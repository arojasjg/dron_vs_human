import { describe, it, expect } from "vitest";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "../src/world/materials";

function saturationLightness(hex: number): { s: number; l: number } {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}
const WALL_TINTS: MaterialId[] = ["wall_slate", "wall_moss", "wall_clay", "wall_navy"];

describe("material table", () => {
  it("glass shatters with far less energy than concrete or metal", () => {
    expect(MATERIALS.glass.strength).toBeLessThan(MATERIALS.concrete.strength);
    expect(MATERIALS.glass.strength).toBeLessThan(MATERIALS.metal.strength);
    expect(MATERIALS.glass.shatters).toBe(true);
  });

  it("metal is the densest (heaviest) material", () => {
    const densest = MATERIAL_ORDER.reduce((a, b) =>
      MATERIALS[a].density >= MATERIALS[b].density ? a : b,
    );
    expect(densest).toBe("metal");
  });

  it("every material in the order has a complete definition", () => {
    for (const id of MATERIAL_ORDER) {
      const m = MATERIALS[id];
      expect(m.density).toBeGreaterThan(0);
      expect(m.strength).toBeGreaterThan(0);
      expect(m.opacity).toBeGreaterThan(0);
    }
  });
});

describe("muted facade tints", () => {
  it("are all low-saturation and dark/sombre (never bright)", () => {
    for (const id of WALL_TINTS) {
      const { s, l } = saturationLightness(MATERIALS[id].color);
      expect(s).toBeLessThan(0.35);   // muted, not vivid
      expect(l).toBeGreaterThan(0.15); // not pitch black
      expect(l).toBeLessThan(0.5);     // sombre, never bright
    }
  });

  it("are physically identical to brick so destruction stays in sync", () => {
    const brick = MATERIALS.brick;
    for (const id of WALL_TINTS) {
      const m = MATERIALS[id];
      expect(m.strength).toBe(brick.strength);
      expect(m.hp).toBe(brick.hp);
      expect(m.density).toBe(brick.density);
      expect(m.color).not.toBe(brick.color); // …but a distinct colour
    }
  });

  it("gives distinct colours across the palette", () => {
    expect(new Set(WALL_TINTS.map((id) => MATERIALS[id].color)).size).toBe(WALL_TINTS.length);
  });
});
