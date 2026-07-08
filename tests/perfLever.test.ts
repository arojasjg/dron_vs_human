import { describe, it, expect } from "vitest";
import { nextPerfLever, SUSTAINED_LOW_SEC } from "../src/engine/perfLever";
import type { Quality } from "../src/engine/quality";

const base = (o: Partial<Parameters<typeof nextPerfLever>[0]> = {}) => ({
  fps: 30, sustainedLowSec: SUSTAINED_LOW_SEC, resAtFloor: true, detailOn: true, quality: "alto" as Quality, ...o,
});

describe("nextPerfLever — the 60fps-floor ladder", () => {
  it("does nothing while fps is healthy or the drop is only momentary", () => {
    expect(nextPerfLever(base({ fps: 60 }))).toBe("none");
    expect(nextPerfLever(base({ fps: 44, sustainedLowSec: 1 }))).toBe("none"); // <4s → not sustained
  });

  it("trims resolution FIRST (non-destructive) before touching any visual", () => {
    expect(nextPerfLever(base({ resAtFloor: false }))).toBe("shrinkRes");
  });

  it("once resolution is floored, drops the mortar detail before the preset", () => {
    expect(nextPerfLever(base({ resAtFloor: true, detailOn: true }))).toBe("dropDetail");
  });

  it("with detail already off, steps the preset down (alto→…→bajo)", () => {
    expect(nextPerfLever(base({ detailOn: false, quality: "alto" }))).toBe("dropPreset");
    expect(nextPerfLever(base({ detailOn: false, quality: "medio" }))).toBe("dropPreset");
  });

  it("at the floor (bajo + detail off) there is nothing left to pull", () => {
    expect(nextPerfLever(base({ detailOn: false, quality: "bajo" }))).toBe("none");
  });

  it("obeys strict rung order and never skips a rung", () => {
    // res not floored wins even if detail is on and the preset is droppable
    expect(nextPerfLever(base({ resAtFloor: false, detailOn: true, quality: "alto" }))).toBe("shrinkRes");
    // res floored + detail on → detail, not preset
    expect(nextPerfLever(base({ resAtFloor: true, detailOn: true, quality: "alto" }))).toBe("dropDetail");
  });
});
