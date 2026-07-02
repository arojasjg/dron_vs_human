/**
 * CPU reference twin of the GPU prefix-sum (scan). The WGSL kernel is a direct
 * transcription of this; the unit tests pin the exact semantics so the GPU port
 * can be validated by buffer readback. Deterministic and dependency-free.
 */

/** Exclusive prefix sum: out[i] = sum(input[0..i-1]); out[0] = 0. */
export function exclusiveScan(input: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(input.length);
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    out[i] = sum;
    sum += input[i];
  }
  return out;
}

/** Inclusive prefix sum: out[i] = sum(input[0..i]). */
export function inclusiveScan(input: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(input.length);
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i];
    out[i] = sum;
  }
  return out;
}

/** Exclusive scan plus the grand total — the shape the broadphase needs. */
export function scanWithTotal(input: ArrayLike<number>): { scan: Uint32Array; total: number } {
  const scan = exclusiveScan(input);
  const total = input.length === 0 ? 0 : scan[input.length - 1] + input[input.length - 1];
  return { scan, total };
}
