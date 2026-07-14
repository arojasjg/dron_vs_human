// Pure spatial-audio math for the enemy-drone rotor: how LOUD, how BRIGHT, how REVVED it sounds as a function
// of the nearest drone's distance, plus the stereo PAN from its bearing. Kept WebAudio/three.js-free so it
// unit-tests directly. The bearing itself is computed with `bearing()` from ui/radar (already tested).

/** Rotor loudness 0..1 from distance: a QUADRATIC falloff (drops off fast → far drones are barely audible),
 *  and exactly 0 at/beyond the audible radius `aud`. Pure. */
export function rotorLevel(dist: number, aud: number): number {
  if (dist >= aud) return 0;
  const t = 1 - Math.max(0, dist) / aud;
  return t * t;
}

/** Low-pass cutoff (Hz) for the rotor: FAR = dull/muffled (air absorption), NEAR = bright. Interpolates by
 *  proximity so a distant rotor is a muffled hum and a close one is a sharp whir. Pure. */
export function rotorCutoff(dist: number, aud: number, far = 450, near = 3800): number {
  const t = Math.max(0, Math.min(1, 1 - Math.max(0, dist) / aud)); // 0 far … 1 near
  return far + (near - far) * t;
}

/** Rotor "speed" (drives the synth pitch): revs UP as the drone closes in, so it STOPS sounding constant.
 *  Pure. */
export function rotorPitch(dist: number, aud: number, base = 16, gain = 48): number {
  const t = Math.max(0, Math.min(1, 1 - Math.max(0, dist) / aud));
  return base + gain * t;
}

/** Stereo pan −1..1 from a bearing (radians, drone direction relative to your facing): right = +, left = −,
 *  front/back ≈ 0. Pure (the sine of the bearing). */
export function rotorPan(bearing: number): number {
  return Math.sin(bearing);
}

/** Brightness multiplier (0.4..1) from a bearing: a drone AHEAD sounds bright (1), one BEHIND you sounds
 *  duller (0.4). Since stereo pan can't tell front from back (both ≈ centre), this gives that cue via the
 *  low-pass. Pure. */
export function frontBrightness(bearing: number): number {
  return 0.4 + 0.6 * (0.5 + 0.5 * Math.cos(bearing)); // cos: +1 ahead … −1 behind
}
