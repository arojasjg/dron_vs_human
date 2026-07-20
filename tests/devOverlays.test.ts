import { describe, it, expect } from "vitest";
import { devOverlaysEnabled, anyModalOpen } from "../src/ui/hud";

// Dev/perf overlays (stats panel + GPU-demo link) must appear ONLY with ?perf — never during normal play,
// and never for the smoke test's ?ptex param.
describe("devOverlaysEnabled", () => {
  it("enables on ?perf", () => expect(devOverlaysEnabled("?perf")).toBe(true));
  it("enables on ?perf=1", () => expect(devOverlaysEnabled("?perf=1")).toBe(true));
  it("stays off with no params", () => expect(devOverlaysEnabled("")).toBe(false));
  it("stays off for the smoke param ?ptex=256", () => expect(devOverlaysEnabled("?ptex=256")).toBe(false));
  it("enables when perf rides alongside another param", () => expect(devOverlaysEnabled("?foo=bar&perf")).toBe(true));
});

// The floating settings gear hides while any full-screen modal (menu / lobby / game-over) is up so it doesn't
// overlap the card. The three modals default to display:none in CSS, so an empty inline display = not open.
describe("anyModalOpen", () => {
  it("no modal when all hidden", () => expect(anyModalOpen("none", "none", "none")).toBe(false));
  it("empty inline display counts as hidden (CSS default is none)", () => expect(anyModalOpen("", "", "")).toBe(false));
  it("menu open", () => expect(anyModalOpen("flex", "none", "none")).toBe(true));
  it("game-over open", () => expect(anyModalOpen("none", "none", "flex")).toBe(true));
  it("lobby open (any non-none/empty display)", () => expect(anyModalOpen("none", "block", "none")).toBe(true));
});
