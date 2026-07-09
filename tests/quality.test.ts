import { describe, it, expect } from "vitest";
import { qualityConfig, qualityAA, autoQuality, QUALITY_ORDER, lowerQuality, shouldAutoDowngrade } from "../src/engine/quality";

describe("graphics quality presets", () => {
  it("scales every cost monotonically: bajo ≤ medio ≤ alto", () => {
    const c = QUALITY_ORDER.map((q) => qualityConfig(q, 2)); // order is [bajo, medio, alto]
    for (let i = 1; i < c.length; i++) {
      expect(c[i].shadow).toBeGreaterThanOrEqual(c[i - 1].shadow);
      expect(c[i].pixelRatio).toBeGreaterThanOrEqual(c[i - 1].pixelRatio);
      expect(Number(c[i].voxelDetail)).toBeGreaterThanOrEqual(Number(c[i - 1].voxelDetail)); // detail scales too
    }
  });

  it("no preset uses image-based lighting — IBL was removed (it alone capped weak GPUs to ~50fps)", () => {
    for (const q of QUALITY_ORDER) expect("ibl" in qualityConfig(q, 2)).toBe(false);
  });

  it("bajo turns off the expensive fragment work (shadows, mortar detail, MSAA, full res)", () => {
    const c = qualityConfig("bajo", 2);
    expect(c.shadow).toBe(0);
    expect(c.pixelRatio).toBeLessThan(1);
    expect(c.voxelDetail).toBe(false); // the ~4ms fwidth mortar shader is gone at the floor
    expect(qualityAA("bajo")).toBe(false);
  });

  it("alto keeps shadows + detail on and caps the pixel ratio", () => {
    expect(qualityConfig("alto", 3).pixelRatio).toBe(1.5); // capped below the device ratio (high-DPI fill-rate save)
    expect(qualityConfig("alto", 2).shadow).toBe(1024); // 1024 (was 2048): a tight sun frustum looks the same, ~3ms cheaper
    expect(qualityConfig("alto", 2).voxelDetail).toBe(true); // full masonry detail on the top preset
    expect(qualityAA("alto")).toBe(true);
  });

  it("auto-detects software rasterisers → bajo, real GPUs → medio", () => {
    expect(autoQuality("Google SwiftShader")).toBe("bajo");
    expect(autoQuality("llvmpipe (LLVM 15.0)")).toBe("bajo");
    expect(autoQuality("AMD Radeon Graphics (GCN 5)")).toBe("medio");
    expect(autoQuality("NVIDIA GeForce RTX 4090")).toBe("medio");
  });

  it("lowerQuality steps down one preset and stops at the lightest", () => {
    expect(lowerQuality("alto")).toBe("medio");
    expect(lowerQuality("medio")).toBe("bajo");
    expect(lowerQuality("bajo")).toBeNull(); // already lightest
  });

  it("shouldAutoDowngrade is a conservative last resort: only a SUSTAINED near-catastrophic drop", () => {
    expect(shouldAutoDowngrade(30, 5, "alto")).toBe(true);   // <45 sustained + can drop → yes
    expect(shouldAutoDowngrade(40, 4, "alto")).toBe(true);   // 40 < 45, 4s → yes
    expect(shouldAutoDowngrade(50, 5, "alto")).toBe(false);  // 50fps → the governor/dynamic-res handle it, not a preset drop
    expect(shouldAutoDowngrade(30, 2, "alto")).toBe(false);  // momentary (2s < 4s) → no
    expect(shouldAutoDowngrade(20, 9, "bajo")).toBe(false);  // already lightest → no
  });
});
