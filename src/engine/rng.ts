// Instance-based deterministic PRNG — the SAME mulberry32 family as world gen (build/prefabs.ts), but a
// standalone object instead of a module-global stream. Destruction randomness is seeded PER EVENT (an
// explode/carve/hit), not drawn from one running stream, so the same event replays byte-identically on
// every client regardless of unrelated local activity or arrival order. This is the foundation of
// deterministic-lockstep multiplayer (Milestone 0).

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }

  /** Next float in [0,1). mulberry32 — identical math to build/prefabs.ts rand(). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [a, b). */
  range(a: number, b: number): number { return a + this.next() * (b - a); }

  /** Symmetric in (-scale/2, +scale/2) — the shape most call sites need (velocity/angle jitter). */
  centered(scale = 1): number { return (this.next() - 0.5) * scale; }
}

// Domain-separation salts: an explode and a hit at the same coordinates must derive DIFFERENT seeds.
export const EVT = { EXPLODE: 1, HIT: 2, COLLAPSE: 3, SHOTGUN: 4 } as const;

/** murmur3-style fold of 32-bit integers into one 32-bit seed. Order-sensitive by design. */
export function mix32(...vals: number[]): number {
  let h = 0x811c9dc5 >>> 0;
  for (let v of vals) {
    v = v | 0;
    v = Math.imul(v, 0xcc9e2d51); v = (v << 15) | (v >>> 17); v = Math.imul(v, 0x1b873593);
    h ^= v; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Wire quantizers — these MUST match the precision the value is broadcast at, so the sender's seed and
// the receiver's seed (recomputed after JSON round-trip) are bit-identical. Uses Math.round, NOT
// Number.prototype.toFixed: toFixed rounds half-away-from-zero on negatives, which would desync any
// negative coordinate. Quantize once at the source, then both apply locally AND broadcast the same value.
export const q2 = (v: number): number => Math.round(v * 100);   // positions: 2 decimals on the wire
export const q3 = (v: number): number => Math.round(v * 1000);  // directions: 3 decimals on the wire

/** Per-event seed from the world seed + event kind + the QUANTIZED wire payload. */
export function eventSeed(worldSeed: number, kind: number, ...q: number[]): number {
  return mix32(worldSeed >>> 0, kind, ...q);
}
