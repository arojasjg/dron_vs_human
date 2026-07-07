import { describe, it, expect } from "vitest";
import { shouldRefreshShadows, SHADOW_ACTIVE_INTERVAL, SHADOW_IDLE_INTERVAL } from "../src/engine/shadowPolicy";

describe("shadow refresh policy — skip the pass when the scene is static", () => {
  it("while active (moving), keeps the ~30Hz cadence exactly as before", () => {
    expect(shouldRefreshShadows(true, 0)).toBe(false);
    expect(shouldRefreshShadows(true, 1)).toBe(false);
    expect(shouldRefreshShadows(true, SHADOW_ACTIVE_INTERVAL)).toBe(true); // every 2 frames
    expect(shouldRefreshShadows(true, 5)).toBe(true);
  });

  it("while static, skips the whole shadow pass until a rare safety refresh (~1s)", () => {
    expect(shouldRefreshShadows(false, 2)).toBe(false);   // would have refreshed if active — now skipped
    expect(shouldRefreshShadows(false, 30)).toBe(false);
    expect(shouldRefreshShadows(false, SHADOW_IDLE_INTERVAL - 1)).toBe(false);
    expect(shouldRefreshShadows(false, SHADOW_IDLE_INTERVAL)).toBe(true); // safety net so nothing gets stuck
  });

  it("the idle interval is much longer than the active one (that gap is the saving)", () => {
    expect(SHADOW_IDLE_INTERVAL).toBeGreaterThan(SHADOW_ACTIVE_INTERVAL * 5);
  });

  it("any moving caster (active=true) always wins over the idle interval", () => {
    // e.g. a drone flies past while the player stands still → active, so it refreshes at 30Hz not 1Hz
    expect(shouldRefreshShadows(true, 2)).toBe(true);
    expect(shouldRefreshShadows(false, 2)).toBe(false);
  });
});
