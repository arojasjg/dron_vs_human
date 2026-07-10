import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSettings, saveSettings, autoSettings, clampViewDist, clampResScale,
  DEFAULT_SETTINGS, VIEW_MIN, VIEW_MAX, RES_MIN_MANUAL, type VisualSettings,
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
    const s: VisualSettings = { quality: "alto", resAuto: false, resScale: 0.75, viewDist: 120 };
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
    saveSettings({ quality: "bajo", resAuto: true, resScale: 1, viewDist: 100 });
    expect(localStorage.getItem("quality")).toBe("bajo");
  });

  it("autoSettings detects the preset from the GPU string and hands resolution to Auto", () => {
    expect(autoSettings("Google SwiftShader")).toEqual({ quality: "bajo", resAuto: true, resScale: 1, viewDist: DEFAULT_SETTINGS.viewDist });
    expect(autoSettings("NVIDIA GeForce RTX 4090").quality).toBe("medio");
    expect(autoSettings("anything").resAuto).toBe(true);
  });
});
