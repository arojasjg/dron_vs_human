// Pure idle-gate decision for the particle systems. When nothing is alive, the caller skips ALL per-frame
// particle work (GPGPU compute + density splat + both draw layers, or the CPU fallback's 4000-slot loop) —
// the reason an empty scene must not pay the full particle cost every frame. Extracted so a guard test can
// assert the gate actually gates (a regression that stops gating would otherwise ship silently).

export interface GateState { active: boolean; aliveUntil: number }

/**
 * Decide whether the particle pipeline must run this frame.
 * @param time         current game time (s)
 * @param aliveUntil   time until which previously-spawned particles may still be alive
 * @param armedMaxLife the largest `life` among emitters armed since last frame, or a negative number if
 *                     none were armed. An armed emitter extends the alive window by its life + a settle margin.
 */
export function idleGate(time: number, aliveUntil: number, armedMaxLife: number): GateState {
  const next = armedMaxLife >= 0 ? Math.max(aliveUntil, time + armedMaxLife + SETTLE_MARGIN) : aliveUntil;
  return { active: armedMaxLife >= 0 || time < next, aliveUntil: next };
}

export const SETTLE_MARGIN = 1; // extra seconds after a particle's nominal life, for settling/fade-out
