import { MAX_DEBRIS_PER_EVENT, VOXEL } from "../config";
import { MATERIALS, type MaterialId } from "../world/materials";

// debris colour-type code (inside the GPU "debris" band 0.6–0.8) per source material, so the GPU
// rubble cloud keeps the colour of whatever was destroyed
export const DEBRIS_CT: Record<MaterialId, number> = {
  concrete: 0.61, brick: 0.65, wood: 0.69, metal: 0.73, glass: 0.77, gastank: 0.73,
  wall_slate: 0.65, wall_moss: 0.65, wall_clay: 0.65, wall_navy: 0.65,
  car_red: 0.73, car_blue: 0.73, car_teal: 0.73, tire: 0.61, leaves: 0.69, leaves_pine: 0.69,
};
import { VoxelGrid, packKey } from "../world/voxelGrid";
import { Rng, mix32 } from "../engine/rng";
import type { DebrisSystem } from "./debris";
import type { ParticleSink } from "../fx/particles";

export interface CarveTargets {
  grid: VoxelGrid;
  debris: DebrisSystem;
  particles: ParticleSink;
}

export interface CarveResult {
  removed: number;
  spawned: number;
}

/**
 * Removes voxels inside a sphere, but only where the impact energy (with linear
 * distance falloff) exceeds the voxel material's strength. Strong materials resist;
 * weak/shattering ones break wide. Removed voxels become rigid debris (or dust once
 * the per-event budget is spent), flung outward from the impact point.
 */
export function carveSphere(
  t: CarveTargets,
  cx: number, cy: number, cz: number,
  radius: number,
  energy: number,
  velScale: number,
  seed: number,
): CarveResult {
  // AMP = how far the crater edge lumps in/out as a fraction of the radius. The lumpiness is a
  // pure function of the blast centre + voxel position (no Math.random), so every client carves
  // the IDENTICAL irregular crater — required by the authoritative destruction sync.
  const AMP = 0.45;
  const maxR = radius * (1 + AMP);
  const [vx0, vy0, vz0] = VoxelGrid.worldToVoxel(cx - maxR, cy - maxR, cz - maxR);
  const [vx1, vy1, vz1] = VoxelGrid.worldToVoxel(cx + maxR, cy + maxR, cz + maxR);

  let removed = 0;
  let spawned = 0;
  const matCount = new Map<MaterialId, number>();
  const vr = new Rng(0); // one instance reseeded per voxel below — avoids thousands of Rng allocations per blast (GC)

  for (let x = vx0; x <= vx1; x++) {
    for (let y = vy0; y <= vy1; y++) {
      for (let z = vz0; z <= vz1; z++) {
        const mat = t.grid.get(x, y, z);
        if (mat === undefined) continue;
        if (t.grid.isIndestructible(x, y, z)) continue; // forest wall / gate vehicles: blasts never carve them
        const wx = (x + 0.5) * VOXEL, wy = (y + 0.5) * VOXEL, wz = (z + 0.5) * VOXEL;
        const dx = wx - cx, dy = wy - cy, dz = wz - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // direction-dependent reach: sine lobes phased by the blast centre make the crater edge
        // lumpy and non-spherical while remaining deterministic across clients.
        const inv = dist > 1e-4 ? 1 / dist : 0;
        const nx = dx * inv, ny = dy * inv, nz = dz * inv;
        const lobe = Math.sin(nx * 4.3 + cx * 0.7) + Math.sin(ny * 3.7 + cy * 0.9)
          + Math.sin(nz * 4.9 + cz * 1.1) + Math.sin((nx + ny + nz) * 2.6);
        const reach = radius * (1 + AMP * lobe / 4); // lobe ∈ [-4,4] → reach ∈ radius·[1-AMP, 1+AMP]
        if (dist > reach) continue;

        const localEnergy = energy * (1 - dist / reach);
        const def = MATERIALS[mat];
        if (localEnergy < def.strength) continue;

        t.grid.remove(x, y, z);
        removed++;
        matCount.set(mat, (matCount.get(mat) ?? 0) + 1);

        // Per-voxel-key RNG (not one sequential stream): identical on every client regardless of the
        // scan/iteration order, so debris launched from the same event/voxel matches everywhere.
        vr.reseed(mix32(seed, packKey(x, y, z)));
        const out = velScale * (0.45 + vr.next() * 0.55);
        const vxv = dx * inv * out + vr.centered(out * 0.4);
        const vyv = dy * inv * out + out * 0.35 + vr.centered(out * 0.4);
        const vzv = dz * inv * out + vr.centered(out * 0.4);

        const pulverize = spawned >= MAX_DEBRIS_PER_EVENT || (def.shatters && vr.next() > 0.55);
        if (!pulverize && t.debris.spawn(wx, wy, wz, mat, vxv, vyv, vzv, VOXEL / 2, vr)) {
          spawned++;
        }
        // pulverised voxels become part of the aggregate dust burst below
      }
    }
  }

  if (removed > 0) {
    t.particles.burst(cx, cy, cz, {
      count: Math.min(20, 4 + removed), color: 0xbfae93, speed: velScale * 0.4,
      size: 9, life: 0.8, buoyancy: -2.2, windCoupling: 0.9, spread: radius,
      kind: "dust", strength: Math.min(0.16, 0.008 + removed / 1200),
    });
    // Mass GPU debris: hundreds–thousands of physical-looking fragments of the REAL destroyed
    // material, flung out and raining down to the ground. Simulated entirely on the GPU, so the
    // count costs nothing on the CPU/physics side.
    let dom: MaterialId = "concrete", best = 0;
    for (const [m, c] of matCount) if (c > best) { best = c; dom = m; }
    t.particles.burst(cx, cy, cz, {
      count: 0, color: 0, speed: velScale * 0.5, life: 12,
      kind: "debris", colorType: DEBRIS_CT[dom],
      strength: Math.min(0.9, 0.08 + removed / 90),
    });
  }

  return { removed, spawned };
}
