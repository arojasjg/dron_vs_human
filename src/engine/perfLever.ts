import { LOW_FPS, lowerQuality, type Quality } from "./quality";

export type PerfLever = "shrinkRes" | "dropDetail" | "dropPreset" | "none";

// Seconds fps must stay below LOW_FPS before the auto-scaler pulls a (destructive) lever. The
// non-destructive responders (governor throttle, dynamic resolution) react in <1s; this is the slow
// last-resort ladder that removes visuals only after a SUSTAINED drop, one rung at a time.
export const SUSTAINED_LOW_SEC = 2.5;

/**
 * The single next quality lever to pull to defend the 60fps floor, in strict cost/visual order:
 *   shrinkRes (cheap — the dynamic-res controller owns it) → dropDetail (kill the ~4ms mortar shader) →
 *   dropPreset (shadows → resolution). Returns "none" while fps is healthy, or once already
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
  // DETAIL FIRST: the ~4 ms mortar-seam fwidth shader is the single biggest per-pixel cost and dropping it
  // barely changes the look (flat vs coursed masonry) — a far better fps/visual trade than blurring the whole
  // screen via resolution. (Was gated behind resAtFloor, but the widened dynamic-res deadband holds res off
  // the floor, so that gate stranded a struggling GPU on the heavy shader forever.)
  if (s.detailOn) return "dropDetail";
  if (!s.resAtFloor) return "shrinkRes";             // then let the dynamic-res controller trim pixels
  if (lowerQuality(s.quality)) return "dropPreset";  // then step the preset down (removes shadows, then res/detail)
  return "none";                                     // bajo + detail off = the floor; nothing left to give
}
