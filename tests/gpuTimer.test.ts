import { describe, it, expect } from "vitest";
import { GpuTimer, type TimerGL, type TimerExt } from "../src/engine/gpuTimer";

const ext: TimerExt = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };

/** A scriptable mock of the tiny GL surface GpuTimer uses. `finish(i, ns)` marks the i-th created query
 *  as available with a nanosecond result; `setDisjoint` flips the disjoint flag. */
function mockGl() {
  const created: object[] = [];
  const ns = new Map<object, number>(); // present ⇒ available
  let disjoint = false;
  const gl: TimerGL = {
    createQuery: () => { const q = {}; created.push(q); return q; },
    deleteQuery: (q) => { ns.delete(q); },
    beginQuery: () => {},
    endQuery: () => {},
    getQueryParameter: (q, p) => (p === gl.QUERY_RESULT_AVAILABLE ? ns.has(q) : (ns.get(q) ?? 0)),
    getParameter: () => (disjoint ? 1 : 0),
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
  };
  return { gl, created, finish: (i: number, nanos: number) => ns.set(created[i], nanos), setDisjoint: (d: boolean) => { disjoint = d; } };
}

describe("GpuTimer", () => {
  it("is null-safe when the extension is unavailable", () => {
    const t = new GpuTimer(null, null);
    expect(t.enabled).toBe(false);
    t.begin(); t.end();
    expect(t.latest()).toBeNull();
  });

  it("returns the GPU-ms once a timed frame's query resolves (a few frames later)", () => {
    const m = mockGl();
    const t = new GpuTimer(m.gl, ext, 4);
    t.begin(); t.end();
    expect(t.latest()).toBeNull();   // not ready yet
    m.finish(0, 12_000_000);         // 12 ms in ns
    expect(t.latest()).toBeCloseTo(12, 5);
  });

  it("discards a DISJOINT result but keeps the last good value", () => {
    const m = mockGl();
    const t = new GpuTimer(m.gl, ext, 4);
    t.begin(); t.end(); m.finish(0, 10_000_000);
    expect(t.latest()).toBeCloseTo(10, 5);
    t.begin(); t.end(); m.finish(1, 99_000_000); m.setDisjoint(true);
    expect(t.latest()).toBeCloseTo(10, 5); // 99ms garbage ignored, previous value retained
  });

  it("keeps timing across many frames without leaking (ring reused)", () => {
    const m = mockGl();
    const t = new GpuTimer(m.gl, ext, 3);
    for (let f = 0; f < 10; f++) { t.begin(); t.end(); m.finish(f, (14 + f) * 1e6); t.latest(); }
    expect(t.latest()).toBeGreaterThan(14); // last resolved values flow through
  });
});
