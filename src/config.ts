export const VOXEL = 0.25;

export const GRAVITY = -9.81;
export const FIXED_DT = 1 / 60;

// CPU rigid debris is the small "hero" layer — the GPU particle layer carries the mass.
// Keeping these low is what holds the frame rate (Rapier is single-threaded on the CPU).
export const MAX_DEBRIS = 24;
export const MAX_DEBRIS_PER_EVENT = 6;
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
