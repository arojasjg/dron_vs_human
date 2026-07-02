export type Voxel = readonly [number, number, number];

const NEIGHBORS: Voxel[] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// numeric voxel key (much faster than "x,y,z" strings for the big flood fills)
const BIAS = 1024, SPAN = 2048;
const pk = (x: number, y: number, z: number) => (x + BIAS) + (y + BIAS) * SPAN + (z + BIAS) * SPAN * SPAN;

/**
 * Returns every solid voxel that is NOT connected (through 6-neighbour adjacency)
 * to an anchored voxel — i.e. the parts that have lost their support and must fall.
 * Pure and dependency-free so it can be unit tested in isolation.
 */
export function findFloatingVoxels(
  cells: Iterable<Voxel>,
  solid: (x: number, y: number, z: number) => boolean,
  isAnchored: (x: number, y: number, z: number) => boolean,
): Voxel[] {
  const all = new Map<number, Voxel>();
  for (const c of cells) all.set(pk(c[0], c[1], c[2]), c);

  const reached = new Set<number>();
  const stack: Voxel[] = [];
  for (const [k, c] of all) {
    if (isAnchored(c[0], c[1], c[2])) {
      reached.add(k);
      stack.push(c);
    }
  }

  while (stack.length) {
    const [x, y, z] = stack.pop()!;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const nk = pk(nx, ny, nz);
      if (!reached.has(nk) && solid(nx, ny, nz)) {
        reached.add(nk);
        stack.push([nx, ny, nz]);
      }
    }
  }

  const floating: Voxel[] = [];
  for (const [k, c] of all) {
    if (!reached.has(k)) floating.push(c);
  }
  return floating;
}

/**
 * Load-bearing support analysis. Support originates at the ground and travels:
 *   - UP, with weight 0: a voxel resting directly on a supported voxel inherits its overhang
 *     (a stack on the ground is fully supported, like compression in real masonry);
 *   - SIDEWAYS, with weight 1: lateral bracing extends support outward, but only up to
 *     `maxOverhang` voxels (a cantilever budget);
 *   - it NEVER travels downward, so anything that merely hangs from above with no path of
 *     support down to the ground is unsupported.
 * Returns every voxel that has no such support and must therefore fall. A single pass is
 * transitive, so removing a thin column collapses everything beyond its overhang reach.
 */
export function findUnsupported(
  cells: Iterable<Voxel>,
  solid: (x: number, y: number, z: number) => boolean,
  isGround: (x: number, y: number, z: number) => boolean,
  maxOverhang: number,
): Voxel[] {
  const all: Voxel[] = [];
  for (const c of cells) all.push(c);

  const overhang = new Map<number, number>(); // supported voxel → its overhang distance
  const buckets: Voxel[][] = [];
  const relax = (x: number, y: number, z: number, o: number) => {
    const k = pk(x, y, z);
    const prev = overhang.get(k);
    if (prev !== undefined && prev <= o) return;
    overhang.set(k, o);
    (buckets[o] ??= []).push([x, y, z]);
  };

  for (const [x, y, z] of all) if (isGround(x, y, z)) relax(x, y, z, 0);

  const done = new Set<number>();
  for (let o = 0; o <= maxOverhang; o++) {
    const bucket = buckets[o];
    if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const [x, y, z] = bucket[i];
      const k = pk(x, y, z);
      if (done.has(k)) continue;
      done.add(k);
      // a voxel resting directly on this one inherits its support (compression, weight 0)
      if (solid(x, y + 1, z)) relax(x, y + 1, z, o);
      // sideways bracing costs one overhang step
      if (o + 1 <= maxOverhang) {
        if (solid(x + 1, y, z)) relax(x + 1, y, z, o + 1);
        if (solid(x - 1, y, z)) relax(x - 1, y, z, o + 1);
        if (solid(x, y, z + 1)) relax(x, y, z + 1, o + 1);
        if (solid(x, y, z - 1)) relax(x, y, z - 1, o + 1);
      }
    }
  }

  const fall: Voxel[] = [];
  for (const c of all) if (!overhang.has(pk(c[0], c[1], c[2]))) fall.push(c);
  return fall;
}

/** Splits a set of voxels into connected islands (6-neighbour adjacency). */
export function connectedComponents(voxels: Voxel[]): Voxel[][] {
  const remaining = new Map<number, Voxel>();
  for (const c of voxels) remaining.set(pk(c[0], c[1], c[2]), c);

  const components: Voxel[][] = [];
  for (const start of voxels) {
    const sk = pk(start[0], start[1], start[2]);
    if (!remaining.has(sk)) continue;

    const comp: Voxel[] = [];
    const stack: Voxel[] = [start];
    remaining.delete(sk);
    while (stack.length) {
      const [x, y, z] = stack.pop()!;
      comp.push([x, y, z]);
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nk = pk(x + dx, y + dy, z + dz);
        const n = remaining.get(nk);
        if (n) {
          remaining.delete(nk);
          stack.push(n);
        }
      }
    }
    components.push(comp);
  }
  return components;
}
