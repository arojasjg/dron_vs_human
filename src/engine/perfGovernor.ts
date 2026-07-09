/**
 * Adaptive quality governor: watches the frame cost and produces a 0..1 budget scale. When the frame is
 * too expensive it shrinks the budget (fewer rigid debris + fewer GPU particles) and restores it as
 * headroom returns — keeping the frame rate stable under load.
 *
 * It reacts to MEASURED GPU-ms when available, not just smoothed fps. During heavy destruction the fps is
 * choppy (30 looking at the city, 90 looking away), so its average fools an fps-only governor into thinking
 * there's headroom; meanwhile the GPU is genuinely pinned at 40-56 ms by debris geometry + particles. GPU-ms
 * is the honest, low-latency signal for exactly the geometry-bound case that dynamic-resolution can't fix
 * (triangle count is resolution-independent), so throttling the debris/particle COUNT is the right lever.
 */
export class PerfGovernor {
  private scale = 1;

  constructor(
    private readonly target = 60,     // fps fallback target (no GPU timer): throttle as we dip toward it
    private readonly gpuBudget = 16,   // ms: ~60 fps of GPU time; over this we're GPU-bound → throttle
    private readonly min = 0.2,
    private readonly down = 0.08,      // shrink per frame while over budget (~10 frames to floor)
    private readonly up = 0.02,        // grow back slowly, so it can't oscillate with recovery frames
  ) {}

  get budgetScale(): number {
    return this.scale;
  }

  /** `gpuMs` is the measured render time (EXT_disjoint_timer_query) or null when unavailable. */
  update(fps: number, gpuMs: number | null = null): number {
    // Over budget on EITHER signal → throttle. GPU-ms is preferred (catches the geometry-bound destruction
    // frames that choppy averaged fps hides); fps is the fallback when the timer query isn't supported.
    const overGpu = gpuMs != null && gpuMs > this.gpuBudget;
    const lowFps = gpuMs == null && fps < this.target - 6;
    // Real headroom on BOTH → grow back. Requires the GPU comfortably under budget so it won't bounce.
    const gpuHeadroom = gpuMs != null ? gpuMs < this.gpuBudget - 3 : fps > this.target - 1;

    if (overGpu || lowFps) this.scale = Math.max(this.min, this.scale - this.down);
    else if (gpuHeadroom) this.scale = Math.min(1, this.scale + this.up);
    return this.scale;
  }
}
