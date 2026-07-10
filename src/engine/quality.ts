// Graphics quality presets. The frame cost on weak GPUs is dominated by fragment work — the shadow-map
// pass, the per-voxel mortar-seam detail (the ~4ms fwidth cost), MSAA and raw pixel count. A preset scales
// all of them together so the game stays >60fps on anything. (Image-based lighting / PMREM reflections were
// removed: on the target GPUs they alone capped the frame to ~50fps — see renderer.ts.)
export type Quality = "bajo" | "medio" | "alto";
export const QUALITY_ORDER: Quality[] = ["bajo", "medio", "alto"];

export interface QualityConfig {
  shadow: number;       // shadow-map resolution; 0 = shadows off
  pixelRatio: number;   // render resolution multiplier
  voxelDetail: boolean; // per-voxel mortar-seam fragment detail (the ~4ms fwidth cost); off = flat masonry
  bloom: boolean;       // ALTO-only additive glow on bright emissives/explosions/muzzle/sun (a post pass, ~2-4ms)
}

export function qualityConfig(q: Quality, dpr: number): QualityConfig {
  switch (q) {
    // pixelRatio is capped BELOW the device ratio: on a high-DPI panel (Retina Mac, dpr 2) rendering at
    // the full physical resolution is a 4× fill-rate cost a fast-moving game doesn't need. 1.5 keeps it
    // crisp at ~half the pixels; the dynamic-res controller trims further under load. Bloom rides ONLY the
    // top preset (the headroom freed by dropping IBL) and the auto-ladder disables it the moment it steps down.
    case "alto": return { shadow: 1024, pixelRatio: Math.min(dpr, 1.25), voxelDetail: true, bloom: true };
    case "medio": return { shadow: 1024, pixelRatio: Math.min(dpr, 1), voxelDetail: true, bloom: false };
    // bajo is the FLOOR: the mortar detail shader (~4ms) and shadows are off too. This is what removes the
    // last of the dominant per-pixel cost so a weak GPU can hold 60 fps with headroom to spare.
    case "bajo": return { shadow: 0, pixelRatio: 0.75, voxelDetail: false, bloom: false };
  }
}

/** Whether MSAA should be requested at renderer-creation time for this preset. */
export function qualityAA(q: Quality): boolean { return q !== "bajo"; }

/** Safe default from the GL renderer string: software rasterisers → the lightest preset, and
 *  everything else → the safe middle. Power users can bump up to Alto (higher render resolution) with the toggle. */
export function autoQuality(gpuName: string): Quality {
  return /swiftshader|llvmpipe|software|microsoft basic|mesa/.test(gpuName.toLowerCase()) ? "bajo" : "medio";
}

/** The next LIGHTER preset (drops shadows, then pixels/detail), or null if already at the lightest. */
export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITY_ORDER.indexOf(q);
  return i > 0 ? QUALITY_ORDER[i - 1] : null;
}

/** Adaptive-downgrade decision — the LAST-resort GPU lever (the governor + dynamic-resolution handle the
 *  50-58 "struggling" range less destructively). Only after a SUSTAINED near-catastrophic drop (<45 for
 *  4 s) does it drop the whole preset (medio→bajo removes the shadow pass + mortar detail). One-way,
 *  so it can't oscillate. Conservative on purpose: it removes the user's chosen visuals. */
export function shouldAutoDowngrade(fps: number, sustainedLowSec: number, q: Quality): boolean {
  return fps < 45 && sustainedLowSec >= 4 && q !== "bajo";
}

/** fps below which the sustained-low timer accumulates → engages the quality ladder (drop detail, then
 *  preset). Raised 45→57: the game targets 60, so a GPU stuck at ~50 (perf.log: cpu 3.5ms, frame 18ms =
 *  GPU-BOUND on the heavy 'alto' preset) must be rescued. At 45 it never engaged in the 50-58 struggle band,
 *  so a weak GPU sat on the ~4ms mortar shader + shadows forever. The 2.5s sustain guards brief dips. */
export const LOW_FPS = 57;
