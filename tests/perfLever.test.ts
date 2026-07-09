import { describe, it, expect } from "vitest";
import { nextPerfLever, SUSTAINED_LOW_SEC } from "../src/engine/perfLever";
import type { Quality } from "../src/engine/quality";

const base = (o: Partial<Parameters<typeof nextPerfLever>[0]> = {}) => ({
  fps: 30, sustainedLowSec: SUSTAINED_LOW_SEC, resAtFloor: true, detailOn: true, quality: "alto" as Quality, ...o,
});

describe("nextPerfLever — the 60fps-floor ladder", () => {
  it("does nothing while fps is healthy or the drop is only momentary", () => {
    expect(nextPerfLever(base({ fps: 60 }))).toBe("none");
    expect(nextPerfLever(base({ fps: 44, sustainedLowSec: 1 }))).toBe("none"); // <2.5s → not sustained
  });

  it("engages in the 50-58 STRUGGLE band (target is 60), not only on a hard crash", () => {
    expect(nextPerfLever(base({ fps: 55, sustainedLowSec: 3 }))).not.toBe("none"); // 55 < LOW_FPS(57) sustained
  });

  it("drops the ~4ms mortar detail FIRST — bigger GPU win, less visual harm than blurring via res", () => {
    // even with res NOT floored, detail goes first (the old res-first gate stranded weak GPUs on the shader)
    expect(nextPerfLever(base({ detailOn: true, resAtFloor: false }))).toBe("dropDetail");
    expect(nextPerfLever(base({ detailOn: true, resAtFloor: true }))).toBe("dropDetail");
  });

  it("with detail off, trims resolution before touching the preset", () => {
    expect(nextPerfLever(base({ detailOn: false, resAtFloor: false }))).toBe("shrinkRes");
  });

  it("with detail off and res floored, steps the preset down (alto→…→bajo)", () => {
    expect(nextPerfLever(base({ detailOn: false, resAtFloor: true, quality: "alto" }))).toBe("dropPreset");
    expect(nextPerfLever(base({ detailOn: false, resAtFloor: true, quality: "medio" }))).toBe("dropPreset");
  });

  it("at the floor (bajo + detail off) there is nothing left to pull", () => {
    expect(nextPerfLever(base({ detailOn: false, resAtFloor: true, quality: "bajo" }))).toBe("none");
  });
});
