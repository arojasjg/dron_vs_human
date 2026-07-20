import { autoQuality, QUALITY_ORDER, type Quality } from "./quality";
import { RENDER_DIST } from "../config";

// A player's visual settings — ALL render-only (never touch the grid/sim, so multiplayer stays deterministic).
// Persisted in localStorage so choices survive a reload. The engine (game.ts) applies them; this module is the
// pure, testable model: defaults, validation/clamping, load/save, and GPU auto-detection. Nothing here throws.
export interface VisualSettings {
  quality: Quality;   // graphics preset (bajo/medio/alto)
  resAuto: boolean;   // true → the dynamic-resolution controller owns the scale; false → resScale is fixed manually
  resScale: number;   // manual resolution multiplier when resAuto is false (RES_MIN_MANUAL..RES_MAX)
  viewDist: number;   // render / distance-cull radius in metres (VIEW_MIN..VIEW_MAX)
  sensitivity: number; // mouse-look multiplier over the base look sens (SENS_MIN..SENS_MAX); 1 = unchanged
  volume: number;      // master audio volume [0..1]; 1 = current loudness (client-only, never touches the sim)
}

export const VIEW_MIN = 50, VIEW_MAX = 160;
export const RES_MIN_MANUAL = 0.5, RES_MAX = 1;
export const SENS_MIN = 0.2, SENS_MAX = 4;
const KEY = "visualSettings";

export const DEFAULT_SETTINGS: VisualSettings = {
  quality: "medio", resAuto: true, resScale: 1, viewDist: RENDER_DIST, sensitivity: 1, volume: 1,
};

// Shared, MUTABLE runtime holder the look controllers read every frame — mutate .value to change look live.
// A plain const object (not a number) so controllers importing it see updates without re-import.
export const lookSens = { value: 1 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clampViewDist = (d: number): number => Math.round(clamp(Number.isFinite(d) ? d : RENDER_DIST, VIEW_MIN, VIEW_MAX));
export const clampResScale = (s: number): number => +clamp(Number.isFinite(s) ? s : 1, RES_MIN_MANUAL, RES_MAX).toFixed(2);
export const clampSensitivity = (s: number): number => +clamp(Number.isFinite(s) ? s : 1, SENS_MIN, SENS_MAX).toFixed(2);
export const clampVolume = (v: number): number => +clamp(Number.isFinite(v) ? v : 1, 0, 1).toFixed(2);

/** Reads + VALIDATES the saved settings, falling back to defaults for anything missing / garbage / out of
 *  range. Never throws — a corrupt blob or an absent localStorage yields the defaults. */
export function loadSettings(): VisualSettings {
  const d = DEFAULT_SETTINGS;
  try {
    if (typeof localStorage === "undefined") return { ...d };
    const raw = localStorage.getItem(KEY);
    if (!raw) { // first run: migrate the legacy single "quality" key if it's there
      const legacy = localStorage.getItem("quality");
      return { ...d, quality: QUALITY_ORDER.includes(legacy as Quality) ? (legacy as Quality) : d.quality };
    }
    const o = JSON.parse(raw) as Partial<VisualSettings>;
    return {
      quality: QUALITY_ORDER.includes(o.quality as Quality) ? (o.quality as Quality) : d.quality,
      resAuto: typeof o.resAuto === "boolean" ? o.resAuto : d.resAuto,
      resScale: clampResScale(o.resScale ?? 1),
      viewDist: clampViewDist(o.viewDist ?? RENDER_DIST),
      sensitivity: clampSensitivity(o.sensitivity ?? 1),
      volume: clampVolume(o.volume ?? 1),
    };
  } catch {
    return { ...d };
  }
}

export function saveSettings(s: VisualSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem("quality", s.quality); // keep the legacy key in sync — renderer.ts reads it at boot for MSAA
  } catch { /* storage full / disabled → run with in-memory settings only */ }
}

/** The "Automático" result: detect the safe preset from the GL renderer string, hand resolution back to the
 *  dynamic-res controller (Auto), and use the default view distance — then the live systems fine-tune in play. */
export function autoSettings(gpuName: string): VisualSettings {
  return { quality: autoQuality(gpuName), resAuto: true, resScale: 1, viewDist: RENDER_DIST, sensitivity: 1, volume: 1 };
}
