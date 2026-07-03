// Pure human-avatar pose + walk-cycle math. No THREE/DOM, so it unit-tests directly. Used by the local
// Walker (stance → eye height + speed) and by the remote avatar (stance pose + leg swing animation).

export type Stance = 0 | 1 | 2 | 3; // 0 stand · 1 crouch · 2 prone · 3 climbing through a window

export interface StanceInfo {
  eye: number;        // first-person camera height above the capsule centre
  speedMul: number;   // movement speed multiplier
  rigLift: number;    // raises the REMOTE model as the eye lowers, so the feet stay near the ground
  legBend: number;    // hip/knee bend applied to the pose (rad)
  bodyLean: number;   // forward pitch of the whole body (rad) — prone tips almost flat
}

export const STANCES: Record<Stance, StanceInfo> = {
  0: { eye: 0.6,   speedMul: 1.0,  rigLift: 0.0, legBend: 0.0, bodyLean: 0.0 },
  1: { eye: 0.12,  speedMul: 0.5,  rigLift: 0.5, legBend: 0.9, bodyLean: 0.15 },
  2: { eye: -0.4,  speedMul: 0.28, rigLift: 0.9, legBend: 0.3, bodyLean: 1.2 },
  3: { eye: 0.3,   speedMul: 0.0,  rigLift: 0.2, legBend: 1.1, bodyLean: 0.9 }, // clambering through a window
};

export function stanceInfo(s: Stance): StanceInfo { return STANCES[s] ?? STANCES[0]; }

/** Walk-cycle hip swing (LEFT leg; the right leg uses the negative). A sinusoid scaled by speed that is
 *  ~zero at rest, so a standing avatar's legs are still. `phase` accumulates with distance walked. */
export function legSwing(phase: number, speed: number, maxSpeed: number): number {
  const amp = Math.min(1, speed / Math.max(1e-3, maxSpeed));
  if (amp < 0.05) return 0;
  return Math.sin(phase) * 0.7 * amp; // up to ±0.7 rad at a full run
}
