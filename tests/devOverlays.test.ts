import { describe, it, expect } from "vitest";
import { devOverlaysEnabled } from "../src/ui/hud";

// Dev/perf overlays (stats panel + GPU-demo link) must appear ONLY with ?perf — never during normal play,
// and never for the smoke test's ?ptex param.
describe("devOverlaysEnabled", () => {
  it("enables on ?perf", () => expect(devOverlaysEnabled("?perf")).toBe(true));
  it("enables on ?perf=1", () => expect(devOverlaysEnabled("?perf=1")).toBe(true));
  it("stays off with no params", () => expect(devOverlaysEnabled("")).toBe(false));
  it("stays off for the smoke param ?ptex=256", () => expect(devOverlaysEnabled("?ptex=256")).toBe(false));
  it("enables when perf rides alongside another param", () => expect(devOverlaysEnabled("?foo=bar&perf")).toBe(true));
});
