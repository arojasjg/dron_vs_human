export const VOXEL = 0.25;

// Render view-bubble radius (metres, horizontal). Mesh chunks whose centre is beyond this are distance-CULLED
// (0 draws/triangles, out of the shadow pass too), so rendered cost depends on the bubble, not the city size
// — this is what lets the world scale (more buildings, houses, a forest wall, 50× trees) at a flat frame cost.
// Tightened 130→100: the indestructible forest wall now rings the map, so you can never see past ~the city
// edge anyway — a 41% smaller bubble (100²/130²) is a direct fps win with nothing new made visible. The FOG
// reaches full opacity BEFORE this radius (see renderer.ts) so there's no visible pop at the cut.
export const RENDER_DIST = 100;

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
// 96→48 / 20→12: perf.log on the TRIPLED town showed world.step spiking to 25-48 ms while destroying
// (phys worstMs, with 39-96 rigid bodies) — the old "96 = cheap" was measured on the small map before the
// city grew (more building colliders for the debris to grind against). Halving the rigid ceiling + the
// per-event spawn burst cuts the physics + spawn spikes; the GPU particle layer still carries the visual
// mass, so destruction still reads rich. The governor scales the LIVE cap down further under load.
export const MAX_DEBRIS = 48;
export const MAX_DEBRIS_PER_EVENT = 12;
export const DEBRIS_SLEEP_DESPAWN = 1.4;

export const AIR_DENSITY = 1.2;
export const DEFAULT_WIND = { x: 1.0, y: 0, z: 0.5 };

// Carve energy of the player's repeatable EXPLOSIVE weapons (grenade / grenade-launcher rocket /
// sandbox cannon). This `power` feeds explode()→carveSphere, so it scales ONLY the STRUCTURAL
// destruction (and the physics impulse) — the anti-PLAYER blast lethality scales with the blast
// RADIUS (see game.ts explodeAt), NOT power. So WEAPON_BLAST_MUL tones down how fast weapons level
// buildings while leaving them exactly as deadly to players. Mega-bomb / kamikaze / gas-tank blasts
// call explodeAt directly with their own power and are deliberately NOT affected (they stay dramatic).
export const BLAST_POWER = { grenade: 560, rocket: 760, cannon: 1000 } as const;
export const WEAPON_BLAST_MUL = 0.55; // ~45% less structural destruction → buildings survive longer

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
