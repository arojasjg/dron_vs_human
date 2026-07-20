import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSettings, saveSettings, autoSettings, clampViewDist, clampResScale, clampSensitivity,
  DEFAULT_SETTINGS, VIEW_MIN, VIEW_MAX, RES_MIN_MANUAL, SENS_MIN, SENS_MAX, type VisualSettings,
} from "../src/engine/settings";

// node has no localStorage — install a minimal in-memory stand-in so save↔load can be exercised.
class LS {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
beforeEach(() => { (globalThis as unknown as { localStorage: LS }).localStorage = new LS(); });

describe("visual settings — pure, validated model", () => {
  it("clamps view distance and resolution, and rejects NaN back to a sane value", () => {
    expect(clampViewDist(9999)).toBe(VIEW_MAX);
    expect(clampViewDist(1)).toBe(VIEW_MIN);
    expect(clampViewDist(NaN)).toBeGreaterThanOrEqual(VIEW_MIN);
    expect(clampResScale(5)).toBe(1);
    expect(clampResScale(0.1)).toBe(RES_MIN_MANUAL);
    expect(clampResScale(NaN)).toBe(1);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a valid settings object through save → load", () => {
    const s: VisualSettings = { quality: "alto", resAuto: false, resScale: 0.75, viewDist: 120, sensitivity: 2.5 };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("VALIDATES a corrupt / out-of-range blob field-by-field back into range (never throws)", () => {
    localStorage.setItem("visualSettings", JSON.stringify({ quality: "ultra", resAuto: "yes", resScale: 9, viewDist: -5 }));
    const s = loadSettings();
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality); // "ultra" not a real preset → default
    expect(s.resAuto).toBe(DEFAULT_SETTINGS.resAuto); // non-boolean → default
    expect(s.resScale).toBe(1);                        // 9 → clamped to max
    expect(s.viewDist).toBe(VIEW_MIN);                 // -5 → clamped to min
  });

  it("tolerates outright garbage JSON without throwing", () => {
    localStorage.setItem("visualSettings", "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates the legacy single 'quality' key when no settings blob exists yet", () => {
    localStorage.setItem("quality", "alto");
    expect(loadSettings().quality).toBe("alto");
  });

  it("saveSettings keeps the legacy 'quality' key in sync (renderer reads it at boot)", () => {
    saveSettings({ quality: "bajo", resAuto: true, resScale: 1, viewDist: 100, sensitivity: 1 });
    expect(localStorage.getItem("quality")).toBe("bajo");
  });

  it("autoSettings detects the preset from the GPU string and hands resolution to Auto", () => {
    expect(autoSettings("Google SwiftShader")).toEqual({ quality: "bajo", resAuto: true, resScale: 1, viewDist: DEFAULT_SETTINGS.viewDist, sensitivity: 1 });
    expect(autoSettings("NVIDIA GeForce RTX 4090").quality).toBe("medio");
    expect(autoSettings("anything").resAuto).toBe(true);
  });

  it("clamps sensitivity, rejects NaN → 1, and rounds to 2 decimals", () => {
    expect(clampSensitivity(99)).toBe(SENS_MAX);   // above max → max
    expect(clampSensitivity(0.01)).toBe(SENS_MIN); // below min → min
    expect(clampSensitivity(NaN)).toBe(1);         // garbage → 1 (the invariant default)
    expect(clampSensitivity(1.239)).toBe(1.24);    // rounded to 2 decimals
    expect(clampSensitivity(1)).toBe(1);           // 1 stays 1 → look byte-identical
  });

  it("INVARIANT: default sensitivity is 1 so the look is unchanged for a player who never touches it", () => {
    expect(DEFAULT_SETTINGS.sensitivity).toBe(1);
    expect(autoSettings("anything").sensitivity).toBe(1);
  });

  it("round-trips sensitivity through save → load, and defaults to 1 when absent / garbage", () => {
    saveSettings({ quality: "medio", resAuto: true, resScale: 1, viewDist: 100, sensitivity: 3.2 });
    expect(loadSettings().sensitivity).toBe(3.2);
    localStorage.setItem("visualSettings", JSON.stringify({ quality: "medio" })); // no sensitivity field
    expect(loadSettings().sensitivity).toBe(1);
    localStorage.setItem("visualSettings", JSON.stringify({ sensitivity: "fast" })); // garbage → 1
    expect(loadSettings().sensitivity).toBe(1);
  });
});
