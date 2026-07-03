// Deterministic per-voxel weathering — a brightness multiplier baked into the mesh's instance colours
// so surfaces read as grimy/worn/stained instead of flat. Pure hash of the voxel position, so a rebuilt
// chunk (or another client's identical grid) weathers IDENTICALLY — no flicker, no multiplayer mismatch.

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Weathering brightness for a voxel: per-voxel wear noise, grime that darkens the lower storeys, and
 *  occasional dark stains/streaks. Returns ~[0.45, 1.05] — multiply the material's base colour by it. */
export function weatherMul(x: number, y: number, z: number): number {
  const h = hash3(x, y, z);
  const wear = 0.9 + (h % 1000) / 1000 * 0.15;          // 0.90..1.05 per-voxel value grain
  const grime = 0.78 + Math.min(1, y * 0.02) * 0.22;    // low voxels darker; clears by ~2.5 storeys up
  const stain = h % 37 === 0 ? 0.6 : 1;                 // ~3% dark grime stains/streaks
  return Math.max(0.45, wear * grime * stain);
}
