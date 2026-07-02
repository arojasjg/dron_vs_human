// Graphics quality presets. The single biggest frame cost on weak GPUs is the fragment work —
// image-based lighting (IBL/PMREM reflections on every PBR pixel), the shadow-map pass, MSAA and
// raw pixel count. A preset scales all of them together so the game stays >60fps on anything.
export type Quality = "bajo" | "medio" | "alto";
export const QUALITY_ORDER: Quality[] = ["bajo", "medio", "alto"];

export interface QualityConfig {
  ibl: boolean;        // image-based reflections (expensive per-pixel)
  shadow: number;      // shadow-map resolution; 0 = shadows off
  pixelRatio: number;  // render resolution multiplier
}

export function qualityConfig(q: Quality, dpr: number): QualityConfig {
  switch (q) {
    case "alto": return { ibl: true, shadow: 2048, pixelRatio: Math.min(dpr, 2) };
    case "medio": return { ibl: false, shadow: 1024, pixelRatio: 1 };
    case "bajo": return { ibl: false, shadow: 0, pixelRatio: 0.75 };
  }
}

/** Whether MSAA should be requested at renderer-creation time for this preset. */
export function qualityAA(q: Quality): boolean { return q !== "bajo"; }

/** Safe default from the GL renderer string: software rasterisers → the lightest preset, and
 *  everything else → the safe middle (no IBL). Power users can bump up to Alto with the toggle. */
export function autoQuality(gpuName: string): Quality {
  return /swiftshader|llvmpipe|software|microsoft basic|mesa/.test(gpuName.toLowerCase()) ? "bajo" : "medio";
}
