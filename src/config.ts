export const VOXEL = 0.25;

export const GRAVITY = -9.81;
export const FIXED_DT = 1 / 60;

// Physics-phase budget (ms). Above this, the fixed-step loop is "heavy" — a big collapse where many
// dynamic debris grind against many voxel colliders can push one Rapier step past 15 ms.
export const HEAVY_PHYSICS_MS = 12;

/** How many fixed physics substeps the frame loop may run this frame. Normal catch-up is 2, but when
 *  the LAST frame's physics phase was already heavy, a 2nd step this frame would DOUBLE the hitch
 *  (measured: a real 29 m tower collapse peaks ~17 ms/step → 2 steps = 34 ms = 29 fps in one frame).
 *  Capping to 1 drops the backlog instead — a slight slow-mo of the LOCAL debris sim (which is never
 *  network-synced) beats a stutter. One-way input → pure & unit-testable. */
export function maxPhysicsSteps(lastPhysMs: number): number {
  return lastPhysMs > HEAVY_PHYSICS_MS ? 1 : 2;
}

// CPU rigid debris is the "hero" layer — chunky rubble you can read as real destruction; the GPU
// particle layer carries the fine dust/mass. These are the CEILING: the perf governor scales the live
// cap by the frame-rate budget (debris.cap = MAX_DEBRIS × budget), so raising them makes destruction
// look richer when there's headroom and still auto-throttles on a weak GPU — the 60fps floor holds.
// 48→96 / 12→20: physics measured cheap (~1.2ms/frame for 54 bodies, no tunneling at these speeds) after
// the collapse-solve cache + off-thread collider cook freed CPU — so more rigid rubble reads as richer
// destruction, and the governor still scales the live cap down by fps so the 60fps floor holds.
export const MAX_DEBRIS = 96;
export const MAX_DEBRIS_PER_EVENT = 20;
export const DEBRIS_SLEEP_DESPAWN = 1.4;

export const AIR_DENSITY = 1.2;
export const DEFAULT_WIND = { x: 1.0, y: 0, z: 0.5 };

// Interactive "hero" debris: a rigid chunk only affects gameplay once its kinetic energy
// (½·m·v²) clears this bar — so fast/heavy shrapnel hurts, slow rubble on the ground does not.
export const DEBRIS_IMPACT_KE = 180;   // joules
export const DEBRIS_HIT_TANK_R = 1.1;  // metres — a fast chunk this close to a gas tank sets it off
export const DEBRIS_HIT_DRONE_R = 1.2; // metres — a fast chunk this close to a drone hurts it

// Load-bearing support: support travels up from the ground (resting on what's below) and
// sideways up to this many voxels (overhang/cantilever budget). It never travels downward,
// so anything merely hanging from above with no base falls. Large enough to keep real spans
// (roofs/floors between walls) standing, small enough that long unsupported overhangs drop.
export const STRUCTURE_MAX_OVERHANG = 11;
