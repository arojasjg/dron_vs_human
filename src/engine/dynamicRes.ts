// Continuous dynamic-resolution controller. Fill rate (pixels shaded) is the #1 GPU cost on this game
// (measured fill-rate bound), so when the GPU can't hold the frame budget we render at a lower internal
// resolution (a scale multiplied into the renderer's pixel ratio) and restore it when there's headroom.
// This is what keeps the "alto" look (shadows + mortar detail) near 60 fps without dropping the whole preset.
// Pure so it unit-tests; the caller debounces the actual setPixelRatio (a drawing-buffer realloc).

export const RES_MIN = 0.42; // floor: 0.42 linear ≈ 18% of the pixels. Low enough that dynamic-res alone can
// rescue a heavy GPU (fill ∝ scale²: a 90 ms frame × 0.42² ≈ 16 ms ≈ 60 fps) WITHOUT dropping shadows/detail.
// Blurry under extreme load, but the 60 fps floor is the priority; it grows back the moment there's headroom.
export const RES_MAX = 1;

// GPU-time controller targets (ms of real render time, from EXT_disjoint_timer_query). The band
// [GROW_MS, BUDGET_MS] is a HOLD zone — no resolution change while gpuMs sits inside it. It MUST bracket
// the normal moving-through-the-city cost (perf.log: gpu 10-15 ms), or the controller shrinks-then-grows
// every ~second, and each change resizes the WebGL drawing buffer — a ~40 ms render STALL on the next
// frame (perf.log: render worstMs 39.7 ms while just moving = the tirón). A wide band keeps res steady so
// reallocs happen only on real view transitions (open field ↔ dense city), not continuously.
export const BUDGET_MS = 15;   // shrink only when the GPU is genuinely over ~66fps of work (heavy destruction)
export const GROW_MS = 9;      // grow back only with real headroom (open view), so the city's ~15ms just holds

const clamp = (s: number) => Math.min(RES_MAX, Math.max(RES_MIN, +s.toFixed(3)));

/**
 * Proportional step from MEASURED GPU-ms (the reliable signal). Fill cost scales ~scale², so to bring
 * gpuMs down to BUDGET we scale by sqrt(BUDGET/gpuMs) — converging in essentially one step instead of the
 * old fixed −0.1 crawl. Grows back only when gpuMs is comfortably under budget, so it can't oscillate
 * (unlike an fps signal, which vsync pins at 60 and hides all headroom).
 */
export function nextResScaleGpu(gpuMs: number, cur: number): number {
  if (gpuMs > BUDGET_MS) return clamp(cur * Math.sqrt(BUDGET_MS / gpuMs)); // over budget → shrink proportionally
  if (gpuMs < GROW_MS) return clamp(cur + 0.05);                            // real headroom → restore gradually
  return cur;                                                               // in the band → hold (no thrash)
}

/**
 * Fallback from smoothed fps when no GPU timer is available (Safari/SwiftShader). Vsync caps fps at the
 * display rate, so only a DROP carries information — shrink proportionally (converges in one 0.4 s tick at
 * 23 fps instead of ~2 s of −0.1 steps), and grow back only slowly since fps can't reveal true headroom.
 */
export function nextResScaleFps(fps: number, cur: number, target = 60): number {
  if (fps < target - 8) return clamp(cur * Math.sqrt(Math.max(0.3, fps / target))); // struggling → drop proportionally
  if (fps > target - 2) return clamp(cur + 0.03);                                   // near cap → nudge back up
  return cur;                                                                        // deadband → hold
}
