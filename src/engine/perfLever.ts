import { LOW_FPS, lowerQuality, type Quality } from "./quality";

export type PerfLever = "shrinkRes" | "dropDetail" | "dropPreset" | "none";

// Seconds fps must stay below LOW_FPS before the auto-scaler pulls a (destructive) lever. The
// non-destructive responders (governor throttle, dynamic resolution) react in <1s; this is the slow
// last-resort ladder that removes visuals only after a SUSTAINED drop, one rung at a time.
export const SUSTAINED_LOW_SEC = 4;

/**
 * The single next quality lever to pull to defend the 60fps floor, in strict cost/visual order:
 *   shrinkRes (cheap — the dynamic-res controller owns it) → dropDetail (kill the ~4ms mortar shader) →
 *   dropPreset (IBL → shadows → resolution). Returns "none" while fps is healthy, or once already
 *   floored (bajo preset with detail off — nothing left to remove). Pure; the caller applies the effect
 *   and resets its sustained-low timer.
 */
export function nextPerfLever(s: {
  fps: number;
  sustainedLowSec: number;
  resAtFloor: boolean;
  detailOn: boolean;
  quality: Quality;
}): PerfLever {
  if (s.fps >= LOW_FPS || s.sustainedLowSec < SUSTAINED_LOW_SEC) return "none"; // not a sustained drop
  if (!s.resAtFloor) return "shrinkRes";             // still pixels to trim → the dynamic-res controller does it
  if (s.detailOn) return "dropDetail";               // floored res, still low → drop the ~4ms mortar detail first
  if (lowerQuality(s.quality)) return "dropPreset";  // then step the preset down (removes IBL, then shadows)
  return "none";                                     // bajo + detail off = the floor; nothing left to give
}
