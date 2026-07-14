// Pure synth parameters per game action. No Web Audio here, so it unit-tests directly; audio.ts turns
// these into oscillator/noise graphs. Tuning lives here so the sound design is data, not buried in code.

export type SfxMaterial = "concrete" | "brick" | "wood" | "glass" | "metal" | "dirt";

export interface ShotSfx {
  crackFreq: number; // bandpass centre of the muzzle crack
  bodyFreq: number;  // low "body" thump
  decay: number;     // seconds
  gain: number;
}

export const WEAPON_SFX: Record<string, ShotSfx> = {
  mg:        { crackFreq: 1800, bodyFreq: 150, decay: 0.09, gain: 0.5 },  // sharp rapid crack
  shotgun:   { crackFreq: 1150, bodyFreq: 85,  decay: 0.24, gain: 0.85 }, // deep loud boom
  grenade:   { crackFreq: 520,  bodyFreq: 120, decay: 0.14, gain: 0.45 }, // launch thunk
  glauncher: { crackFreq: 600,  bodyFreq: 100, decay: 0.16, gain: 0.5 },
  net:       { crackFreq: 900,  bodyFreq: 220, decay: 0.2,  gain: 0.35 }, // airy whoosh
  bullet:    { crackFreq: 1700, bodyFreq: 150, decay: 0.09, gain: 0.45 }, // generic tracer (remote)
  sniper:    { crackFreq: 1350, bodyFreq: 70,  decay: 0.3,  gain: 1.0 },  // heavy, deep rifle CRACK + long tail
};

/** Explosion synth params scale with blast power (a grenade ≈ 360, a rocket ≈ 520, kamikaze ≈ 900). */
export function explosionParams(power: number): { decay: number; gain: number; subFreq: number } {
  const p = Math.max(0.2, Math.min(2, power / 500));
  return { decay: 0.5 + p * 0.6, gain: Math.min(1, 0.6 + p * 0.25), subFreq: 95 - p * 30 };
}

export interface ImpactSfx {
  filter: "lowpass" | "highpass" | "bandpass";
  freq: number;
  decay: number;
  gain: number;
  ring: boolean; // metal/glass keep a resonant tail
}

export const IMPACT_SFX: Record<SfxMaterial, ImpactSfx> = {
  concrete: { filter: "lowpass",  freq: 900,  decay: 0.10, gain: 0.4,  ring: false },
  brick:    { filter: "lowpass",  freq: 1100, decay: 0.09, gain: 0.4,  ring: false },
  wood:     { filter: "bandpass", freq: 1400, decay: 0.08, gain: 0.35, ring: false },
  glass:    { filter: "highpass", freq: 5200, decay: 0.26, gain: 0.5,  ring: true },  // shatter tinkle
  metal:    { filter: "bandpass", freq: 3200, decay: 0.36, gain: 0.45, ring: true },  // ping
  dirt:     { filter: "lowpass",  freq: 480,  decay: 0.07, gain: 0.3,  ring: false },
};

/** Volume falloff for a spatial event `dist` metres from the listener (1 at the ear → 0 far away). */
export function distanceGain(dist: number, ref = 28): number {
  return Math.max(0, Math.min(1, ref / (ref + Math.max(0, dist))));
}
