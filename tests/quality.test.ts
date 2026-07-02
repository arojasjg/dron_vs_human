import { describe, it, expect } from "vitest";
import { qualityConfig, qualityAA, autoQuality, QUALITY_ORDER } from "../src/engine/quality";

describe("graphics quality presets", () => {
  it("scales every cost monotonically: bajo ≤ medio ≤ alto", () => {
    const c = QUALITY_ORDER.map((q) => qualityConfig(q, 2)); // order is [bajo, medio, alto]
    for (let i = 1; i < c.length; i++) {
      expect(c[i].shadow).toBeGreaterThanOrEqual(c[i - 1].shadow);
      expect(c[i].pixelRatio).toBeGreaterThanOrEqual(c[i - 1].pixelRatio);
      expect(Number(c[i].ibl)).toBeGreaterThanOrEqual(Number(c[i - 1].ibl));
    }
  });

  it("bajo turns off the expensive fragment work (IBL, shadows, MSAA, full res)", () => {
    const c = qualityConfig("bajo", 2);
    expect(c.ibl).toBe(false);
    expect(c.shadow).toBe(0);
    expect(c.pixelRatio).toBeLessThan(1);
    expect(qualityAA("bajo")).toBe(false);
  });

  it("alto keeps them on and caps the pixel ratio", () => {
    expect(qualityConfig("alto", 3).pixelRatio).toBe(2); // capped at 2
    expect(qualityConfig("alto", 2).ibl).toBe(true);
    expect(qualityConfig("alto", 2).shadow).toBe(2048);
    expect(qualityAA("alto")).toBe(true);
  });

  it("auto-detects software rasterisers → bajo, real GPUs → medio", () => {
    expect(autoQuality("Google SwiftShader")).toBe("bajo");
    expect(autoQuality("llvmpipe (LLVM 15.0)")).toBe("bajo");
    expect(autoQuality("AMD Radeon Graphics (GCN 5)")).toBe("medio");
    expect(autoQuality("NVIDIA GeForce RTX 4090")).toBe("medio");
  });
});
