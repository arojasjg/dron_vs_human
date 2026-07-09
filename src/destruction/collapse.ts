import { MAX_DEBRIS_PER_EVENT } from "../config";
import { VoxelGrid } from "../world/voxelGrid";
import type { MaterialId } from "../world/materials";
import { Rng, mix32, EVT } from "../engine/rng";

// Coarse structural-collapse constants (moved out of game.ts so the tick is pure + headless-testable).
export const CELL_OVERHANG = 2;    // lateral cantilever budget (2m cells) — an intact city stands at 2
export const CELL_MIN_MASS = 12;   // a cell bears load only with ≥ this many structural voxels (sliver floor)
export const PANCAKE_FRAC = 0.5;   // a storey with section < frac × mass-above pancakes the floors above
export const COLLAPSE_BUDGET = 16; // cells drained per tick — spreads a building-wide collapse over frames.
// Lowered 48→24: each drained cell dirties mesh chunks, so a big per-tick drain SPIKED both the collapse
// step AND the following mesh rebuild in the same frame (measured in perf.log: collapse ~30ms + rebuild
// ~14ms during destruction). Half the cells/tick halves both spikes and spreads the collapse over 2× the
// frames (imperceptible slow-mo). Deterministic: same cells in the same sorted order, just fewer per tick.

/** Called with a fallen voxel BEFORE it leaves the grid (game clears its impact decal + marks the chunk). */
export type OnRemoved = (k: number, x: number, y: number, z: number) => void;
/** Called once per drained slice that dropped voxels (game spawns the GPU dust burst + VS rubble damage). */
export type OnWave = (cx: number, cy: number, cz: number, n: number, dom: MaterialId) => void;
export type SpawnDebris = (x: number, y: number, z: number, mat: MaterialId, vx: number, vy: number, vz: number, rng: Rng) => boolean;

/**
 * One tick of the coarse structural collapse — the PURE core lifted out of Game.collapseStep so it runs
 * identically headless (the divergence harness) and in the fixed-tick sim (M1). Solves support over the
 * cell graph (topological ∪ pancake) when the previous fallen wave is drained, then drops COLLAPSE_BUDGET
 * cells' voxels. Deterministic on the synced grid: fixed iteration budget, per-voxel-key RNG for the rubble
 * (same as carve). Mutates `pendingFall` in place; returns true while collapse is still active.
 */
export function collapseTick(
  grid: VoxelGrid,
  pendingFall: number[],
  worldSeed: number,
  spawnDebris: SpawnDebris,
  onRemoved: OnRemoved,
  onWave: OnWave,
): boolean {
  if (pendingFall.length === 0) {
    // Re-solve only when the previous wave is fully drained (re-running every frame was the settle spike).
    const topo = grid.fallenCells(CELL_OVERHANG, CELL_MIN_MASS);
    const pan = grid.pancakeCells(CELL_MIN_MASS, PANCAKE_FRAC);
    const fall = pan.length ? [...new Set([...topo, ...pan])] : topo;
    if (fall.length === 0) return false; // settled — nothing left unsupported
    // M2: canonical drain order (fallenCells/pancakeCells emit in Map-insertion order, which differs
    // across machines). Sorting the cell keys makes WHICH cells drop first — and thus the rubble spawn
    // order — deterministic cross-client. The final grid is unchanged (the set of fallen cells is equal).
    fall.sort((a, b) => a - b);
    pendingFall.push(...fall);
  }
  const matCount = new Map<MaterialId, number>();
  const cr = new Rng(0); // reseeded per voxel below — one instance instead of thousands of allocations (GC)
  let sx = 0, sy = 0, sz = 0, nn = 0, cubes = 0;
  const limit = Math.min(pendingFall.length, COLLAPSE_BUDGET);
  for (let ci = 0; ci < limit; ci++) {
    for (const k of grid.cellVoxelKeys(pendingFall[ci])) {
      const x = (k % 1024) - 512, y = (Math.floor(k / 1024) % 1024) - 512, z = Math.floor(k / 1048576) - 512;
      const mat = grid.get(x, y, z);
      if (mat === undefined) continue;
      matCount.set(mat, (matCount.get(mat) ?? 0) + 1);
      sx += x; sy += y; sz += z; nn++;
      onRemoved(k, x, y, z);
      grid.remove(x, y, z);
      // a few pooled CPU cubes (sparse) for close-up rubble; GPU debris carries the mass
      if (cubes < MAX_DEBRIS_PER_EVENT && ((x + y + z) & 7) === 0) {
        const c = VoxelGrid.center(x, y, z);
        cr.reseed(mix32(worldSeed, EVT.COLLAPSE, k)); // per-voxel-key → deterministic rubble
        if (spawnDebris(c.x, c.y, c.z, mat, cr.centered(0.8), -0.2, cr.centered(0.8), cr)) cubes++;
      }
    }
  }
  pendingFall.splice(0, limit); // drop the drained slice; emptied → re-solve next call (cascade)
  if (nn > 0) {
    let dom: MaterialId = "concrete", best = 0;
    for (const [m, c] of matCount) if (c > best) { best = c; dom = m; }
    const wc = VoxelGrid.center(Math.round(sx / nn), Math.round(sy / nn), Math.round(sz / nn));
    onWave(wc.x, wc.y, wc.z, nn, dom);
  }
  return true; // still active (more to drain, or a re-solve to catch the cascade next call)
}
