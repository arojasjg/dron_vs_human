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
// [GROW_MS, BUDGET_MS] is a HOLD zone — no resolution change while gpuMs sits inside it. It must bracket the
// gpu-ms that ACTUALLY corresponds to 60 fps on the target machine, NOT a rounder number. Measured on a weak
// GPU (perf.log, foreground ALTO): gpu 14-17 ms rendered at only 43-50 fps (frame 22-26 ms — the ~7 ms of
// present/pipeline on top of the timer means gpu 15 ms ≈ 45 fps, not 66). So the old BUDGET_MS 15 tolerated
// 45 fps as "fine" and left res stuck at 0.85. Retargeted to ~11 ms → the controller trims pixels until the
// frame really lands near 16.7 ms. Still a band (reallocs only on view transitions, not per-frame thrash).
export const BUDGET_MS = 11;   // over this the frame misses 60 → shrink; ~11 ms gpu ≈ 16.7 ms frame here
export const GROW_MS = 7;      // grow back only with genuine headroom (open view), so the steady city holds

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
