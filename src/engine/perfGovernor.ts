/**
 * Adaptive quality governor: watches the frame rate and produces a 0..1 budget
 * scale. When FPS drops below target it shrinks the budget (fewer rigid debris),
 * and restores it as headroom returns — keeping the frame rate stable under load.
 */
export class PerfGovernor {
  private scale = 1;

  constructor(
    private readonly target = 60, // aim for 60 fps: throttle effects as soon as we dip toward it
    private readonly min = 0.2,
    private readonly down = 0.05,
    private readonly up = 0.02,
  ) {}

  get budgetScale(): number {
    return this.scale;
  }

  update(fps: number): number {
    if (fps < this.target - 6) {
      this.scale = Math.max(this.min, this.scale - this.down);
    } else if (fps > this.target - 1) {
      this.scale = Math.min(1, this.scale + this.up);
    }
    return this.scale;
  }
}
