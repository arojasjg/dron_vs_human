import { describe, it, expect } from "vitest";
import { Rng, mix32, eventSeed, EVT, q2, q3 } from "../src/engine/rng";

describe("Rng — deterministic seeded PRNG", () => {
  it("same seed → identical stream; different seed → different stream", () => {
    const a = new Rng(12345), b = new Rng(12345), c = new Rng(12346);
    const sa = Array.from({ length: 8 }, () => a.next());
    const sb = Array.from({ length: 8 }, () => b.next());
    const sc = Array.from({ length: 8 }, () => c.next());
    expect(sa).toEqual(sb);         // reproducible
    expect(sa).not.toEqual(sc);     // seed-sensitive
    for (const v of sa) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });

  it("centered() is bounded by ±scale/2", () => {
    const r = new Rng(7);
    for (let i = 0; i < 200; i++) expect(Math.abs(r.centered(8))).toBeLessThanOrEqual(4);
  });

  it("range() stays within [a,b)", () => {
    const r = new Rng(99);
    for (let i = 0; i < 200; i++) { const v = r.range(-3, 5); expect(v).toBeGreaterThanOrEqual(-3); expect(v).toBeLessThan(5); }
  });
});

describe("event seeds — cross-client stability", () => {
  it("same quantized payload → same seed, no matter who computes it", () => {
    const s1 = eventSeed(999, EVT.EXPLODE, q2(1.234), q2(-5.678), q2(9.0), q2(3.4), 520);
    const s2 = eventSeed(999, EVT.EXPLODE, q2(1.234), q2(-5.678), q2(9.0), q2(3.4), 520);
    expect(s1).toBe(s2);
  });

  it("survives the wire round-trip (JSON stringify/parse), including negatives near zero", () => {
    const x = -5.678, y = 9.004, z = -0.001, r = 3.4, p = 520;
    const senderSeed = eventSeed(999, EVT.EXPLODE, q2(x), q2(y), q2(z), q2(r), p);
    // what actually crosses the wire = the quantized values
    const msg = { x: q2(x) / 100, y: q2(y) / 100, z: q2(z) / 100, r, p };
    const recv = JSON.parse(JSON.stringify(msg)) as typeof msg;
    const recvSeed = eventSeed(999, EVT.EXPLODE, q2(recv.x), q2(recv.y), q2(recv.z), q2(recv.r), recv.p);
    expect(recvSeed).toBe(senderSeed);
  });

  it("domain separation: kind / coords / worldSeed each change the seed", () => {
    const base = eventSeed(1, EVT.EXPLODE, 100, 200, 300);
    expect(eventSeed(1, EVT.HIT, 100, 200, 300)).not.toBe(base);       // different kind
    expect(eventSeed(2, EVT.EXPLODE, 100, 200, 300)).not.toBe(base);   // different world
    expect(eventSeed(1, EVT.EXPLODE, 101, 200, 300)).not.toBe(base);   // different coord
  });

  it("quantizers use Math.round (stable on negatives)", () => {
    expect(q2(3.14)).toBe(314);
    expect(q3(3.14159)).toBe(3142);
    expect(q2(-2.5)).toBe(-250);
    // Math.round(-0.1) is -0; the seed must treat -0 and +0 identically (mix32 does `v | 0`)
    expect(eventSeed(1, EVT.EXPLODE, q3(-0.0001))).toBe(eventSeed(1, EVT.EXPLODE, 0));
  });

  it("mix32 is order-sensitive (a fold, not a sum)", () => {
    expect(mix32(1, 2, 3)).not.toBe(mix32(3, 2, 1));
    expect(mix32(1, 2, 3)).toBe(mix32(1, 2, 3));
  });
});
