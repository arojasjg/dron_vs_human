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

export interface RGB { r: number; g: number; b: number; }

/**
 * Weathering as a per-channel RGB multiplier (multiplies the material base colour, like weatherMul but
 * chromatic). On top of the brightness it adds SUBTLE, believable staining so a flat greedy-merged wall
 * reads as aged masonry instead of grey noise: warm brown grime low down, rare rust-orange vertical
 * streaks under sills (a whole column tinted, darkening toward the base), and occasional cool-green damp.
 * `saturate=false` (glass / painted metal / tyres) keeps it neutral so speculars stay clean — dirty
 * rainbow glass looks worse. Pure position hash → identical on every client (visual only anyway).
 */
export function weatherTint(x: number, y: number, z: number, saturate: boolean, out: RGB): RGB {
  const v = weatherMul(x, y, z);
  if (!saturate) { out.r = v; out.g = v; out.b = v; return out; }
  const h = hash3(x, y, z);
  const low = Math.max(0, 1 - y * 0.05) * 0.10;                 // warm ground grime, fades by ~y20
  const rust = hash3(x, 0, z) % 29 === 0 ? Math.max(0, 1 - y * 0.05) * 0.14 : 0; // rare rust streak columns
  const damp = h % 43 === 0 ? 0.10 : 0;                          // occasional cool damp patch
  const clamp = (c: number) => Math.min(1.1, Math.max(0.35, c));
  out.r = clamp(v * (1 + low + rust - damp));
  out.g = clamp(v * (1 + low * 0.5 + rust * 0.4 + damp * 0.4));
  out.b = clamp(v * (1 - low * 0.6 - rust * 1.1 + damp * 0.2));
  return out;
}
