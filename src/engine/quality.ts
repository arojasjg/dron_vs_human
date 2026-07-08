// Graphics quality presets. The single biggest frame cost on weak GPUs is the fragment work —
// image-based lighting (IBL/PMREM reflections on every PBR pixel), the shadow-map pass, MSAA and
// raw pixel count. A preset scales all of them together so the game stays >60fps on anything.
export type Quality = "bajo" | "medio" | "alto";
export const QUALITY_ORDER: Quality[] = ["bajo", "medio", "alto"];

export interface QualityConfig {
  ibl: boolean;         // image-based reflections (expensive per-pixel)
  shadow: number;       // shadow-map resolution; 0 = shadows off
  pixelRatio: number;   // render resolution multiplier
  voxelDetail: boolean; // per-voxel mortar-seam fragment detail (the ~4ms fwidth cost); off = flat masonry
}

export function qualityConfig(q: Quality, dpr: number): QualityConfig {
  switch (q) {
    // pixelRatio is capped BELOW the device ratio: on a high-DPI panel (Retina Mac, dpr 2) rendering at
    // the full physical resolution is a 4× fill-rate cost a fast-moving game doesn't need. 1.5 keeps it
    // crisp at ~half the pixels; the dynamic-res controller trims further under load.
    case "alto": return { ibl: true, shadow: 1024, pixelRatio: Math.min(dpr, 1.5), voxelDetail: true };
    case "medio": return { ibl: false, shadow: 1024, pixelRatio: Math.min(dpr, 1), voxelDetail: true };
    // bajo is the FLOOR: the mortar detail shader (~4ms) is off too, not just IBL/shadows. This is what
    // finally removes the dominant per-pixel cost so a weak GPU can actually hold 60 fps.
    case "bajo": return { ibl: false, shadow: 0, pixelRatio: 0.75, voxelDetail: false };
  }
}

/** Whether MSAA should be requested at renderer-creation time for this preset. */
export function qualityAA(q: Quality): boolean { return q !== "bajo"; }

/** Safe default from the GL renderer string: software rasterisers → the lightest preset, and
 *  everything else → the safe middle (no IBL). Power users can bump up to Alto with the toggle. */
export function autoQuality(gpuName: string): Quality {
  return /swiftshader|llvmpipe|software|microsoft basic|mesa/.test(gpuName.toLowerCase()) ? "bajo" : "medio";
}

/** The next LIGHTER preset (drops shadows/IBL/pixels), or null if already at the lightest. */
export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITY_ORDER.indexOf(q);
  return i > 0 ? QUALITY_ORDER[i - 1] : null;
}

/** Adaptive-downgrade decision — the LAST-resort GPU lever (the governor + dynamic-resolution handle the
 *  50-58 "struggling" range less destructively). Only after a SUSTAINED near-catastrophic drop (<45 for
 *  4 s) does it drop the whole preset (alto→medio removes per-pixel IBL + the big shadow map). One-way,
 *  so it can't oscillate. Conservative on purpose: it removes the user's chosen visuals. */
export function shouldAutoDowngrade(fps: number, sustainedLowSec: number, q: Quality): boolean {
  return fps < 45 && sustainedLowSec >= 4 && q !== "bajo";
}

/** fps below which the sustained-low timer accumulates (matches shouldAutoDowngrade's threshold). */
export const LOW_FPS = 45;
