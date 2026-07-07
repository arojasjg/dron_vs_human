// Pure camera-feel math for the drone and the human. No THREE / DOM here, so it unit-tests directly.
// All angles are radians; offsets are metres. Banking is applied as a roll around the camera's forward
// axis, which does NOT change the look/aim direction — safe to add on top of mouse-aim.

export const DRONE_MAX_BANK = 0.3;     // rad (~17°) roll at full lateral speed
export const DRONE_FOV_BASE = 78;
export const DRONE_FOV_BOOST = 92;     // FOV widens toward this at boost speed → sense of speed
export const HUMAN_FOV = 72;

// NOTE: drone tilt is ROLL ONLY (about the view axis) — it must never become a pitch/yaw tilt, which
// would rotate camera.getWorldDirection() and desync the aim from the crosshair. Keep it roll-safe.

/** Roll to bank INTO a lateral (right-positive) velocity, like a quadcopter leaning to translate. */
export function droneBank(rightVel: number, maxSpeed: number): number {
  const t = clamp(rightVel / Math.max(1e-3, maxSpeed), -1, 1);
  return -t * DRONE_MAX_BANK;
}

/** Small idle oscillation so a hovering drone is never perfectly locked in place. */
export function hoverSway(time: number): { dx: number; dy: number; roll: number } {
  return {
    dx: Math.sin(time * 1.7) * 0.012,
    dy: Math.sin(time * 2.3 + 1.0) * 0.02,
    roll: Math.sin(time * 1.1) * 0.01,
  };
}

/** FOV eased target that widens with speed (base at rest → boost at maxSpeed). */
export function speedFov(base: number, boost: number, speed: number, maxSpeed: number): number {
  const t = clamp(speed / Math.max(1e-3, maxSpeed), 0, 1);
  return base + (boost - base) * t;
}

/** Walking head-bob: vertical bob (2× stride), lateral sway + slight roll (1× stride), scaled by speed.
 *  `phase` accumulates with distance walked so the bob syncs to strides; ~zero when standing still. */
export function headBob(phase: number, speed: number, maxSpeed: number): { dy: number; dx: number; roll: number } {
  const amp = clamp(speed / Math.max(1e-3, maxSpeed), 0, 1);
  if (amp < 0.05) return { dy: 0, dx: 0, roll: 0 };
  return {
    dy: Math.sin(phase * 2) * 0.05 * amp,
    dx: Math.cos(phase) * 0.035 * amp,
    roll: Math.cos(phase) * 0.014 * amp,
  };
}

export const TRAUMA_DECAY = 1.5;       // trauma units shed per second
export const SHAKE_POS = 0.16;         // metres of positional shake at full trauma
export const SHAKE_ROLL = 0.05;        // rad of roll shake at full trauma

/** Accumulate trauma from an event (explosion nearby, taking damage, firing), clamped to 1. */
export function addTrauma(cur: number, amount: number): number { return clamp(cur + amount, 0, 1); }

/** Trauma bleeds off linearly so a shake always settles. */
export function decayTrauma(cur: number, dt: number): number { return Math.max(0, cur - TRAUMA_DECAY * dt); }

/**
 * Screen-shake offset from trauma. Magnitude ∝ trauma² (smooth falloff — Eiserloh's trauma model), driven
 * by high-frequency incommensurate sines so it reads as a jolt, not a wobble. POSITIONAL + ROLL ONLY, and
 * roll is about the view axis — so the LOOK/aim direction is never rotated. This is the invariant that lets
 * shake stack on mouse-aim without ever desyncing the crosshair from the broadcast shot direction.
 */
export function shakeOffset(trauma: number, time: number): { dx: number; dy: number; dz: number; roll: number } {
  const s = trauma * trauma;
  if (s < 1e-4) return { dx: 0, dy: 0, dz: 0, roll: 0 };
  const f = 33;
  return {
    dx: s * SHAKE_POS * Math.sin(time * f),
    dy: s * SHAKE_POS * Math.sin(time * f * 1.13 + 1.7),
    dz: s * SHAKE_POS * 0.4 * Math.sin(time * f * 0.91 + 3.1),
    roll: s * SHAKE_ROLL * Math.sin(time * f * 1.07 + 5.0),
  };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
