import { describe, it, expect } from "vitest";
import { HELP, HELP_COMBAT } from "../src/ui/hud";

// Locks the two in-game help texts apart: combat H must document the REAL combat keybinds and must NOT
// leak sandbox-only controls (tools/materials/build/mega-bomb/save-load), while the sandbox H keeps them.
describe("in-game help is mode-aware", () => {
  it("combat help documents the real combat keys", () => {
    expect(HELP_COMBAT).toContain("<b>R</b> recargar"); // reload / scan
    expect(HELP_COMBAT).toContain("<b>V</b> cuerpo a cuerpo"); // melee
    expect(HELP_COMBAT).toContain("<b>1-6</b> tus armas"); // class weapon loadout
    expect(HELP_COMBAT).toContain("<b>WASD</b> moverse");
    expect(HELP_COMBAT).toContain("<b>Z</b> cuerpo a tierra"); // prone
    expect(HELP_COMBAT).toContain("apuntar"); // right-click ADS
  });

  it("combat help does NOT show sandbox-only controls", () => {
    expect(HELP_COMBAT).not.toContain("MEGA BOMBA");
    expect(HELP_COMBAT).not.toContain("material");
    expect(HELP_COMBAT).not.toContain("muro");
    expect(HELP_COMBAT).not.toContain("torre");
    expect(HELP_COMBAT).not.toContain("guardar");
  });

  it("sandbox help keeps its build/tool tokens", () => {
    expect(HELP).toContain("MEGA BOMBA");
    expect(HELP).toContain("material");
    expect(HELP).toContain("muro");
    expect(HELP).toContain("Construir");
  });
});
