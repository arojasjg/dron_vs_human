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

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
