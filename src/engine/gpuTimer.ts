// Real GPU-time measurement via EXT_disjoint_timer_query_webgl2. CPU-side timing (performance.now around
// render) only measures command SUBMIT — the GPU work is async, so on a fill-rate-bound scene it hides the
// true cost. This measures actual GPU ms, which is what the dynamic-resolution controller needs.
//
// Results are ready a few frames after end(), so a small RING of queries lets us keep timing every frame
// without ever stalling on getQueryParameter. Fully null-safe: with no extension (Safari, SwiftShader)
// every method is a no-op and latest() returns null → callers fall back to the fps signal.

/** Minimal slice of the WebGL2 + timer-extension surface we use — so this is unit-testable with a mock. */
export interface TimerGL {
  createQuery(): object | null;
  deleteQuery(q: object): void;
  beginQuery(target: number, q: object): void;
  endQuery(target: number): void;
  getQueryParameter(q: object, pname: number): unknown;
  getParameter(pname: number): unknown;
  QUERY_RESULT: number;
  QUERY_RESULT_AVAILABLE: number;
}
export interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number; }

export class GpuTimer {
  private readonly inFlight: (object | null)[];
  private head = 0;
  private pending: object | null = null; // query currently open between begin() and end()
  private lastMs: number | null = null;

  constructor(private readonly gl: TimerGL | null, private readonly ext: TimerExt | null, size = 4) {
    this.inFlight = new Array(Math.max(2, size)).fill(null);
  }

  /** Available only when the extension resolved. */
  get enabled(): boolean { return !!this.gl && !!this.ext; }

  /** Begin timing this frame's GPU work. No-op if disabled or the head slot is still resolving. */
  begin(): void {
    if (!this.gl || !this.ext || this.pending) return;
    if (this.inFlight[this.head]) return; // ring full → skip timing this frame (keep the pipeline free)
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.pending = q;
  }

  /** End the current timing and enqueue it for later polling. */
  end(): void {
    if (!this.gl || !this.ext || !this.pending) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inFlight[this.head] = this.pending;
    this.pending = null;
    this.head = (this.head + 1) % this.inFlight.length;
  }

  /** Reap any finished queries and return the most recent GPU-ms (or the last known value / null). */
  latest(): number | null {
    if (!this.gl || !this.ext) return null;
    const disjoint = !!this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = 0; i < this.inFlight.length; i++) {
      const q = this.inFlight[i];
      if (!q) continue;
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) this.lastMs = (this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number) / 1e6;
      this.gl.deleteQuery(q); // disjoint result is garbage → discard, keep the previous lastMs
      this.inFlight[i] = null;
    }
    return this.lastMs;
  }
}

/** Builds a GpuTimer from a live WebGL2 context (or a disabled one if the extension is blocked). */
export function makeGpuTimer(gl: WebGL2RenderingContext, size = 4): GpuTimer {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as unknown as TimerExt | null;
  return new GpuTimer(ext ? (gl as unknown as TimerGL) : null, ext, size);
}
