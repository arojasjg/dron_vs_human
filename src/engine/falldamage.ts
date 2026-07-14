// Fall / impact damage. Pure math so it unit-tests without a physics world.
const STOREY = 4.75;              // metres per storey (STRIDE 19 voxels × VOXEL 0.25)
const FALL_SAFE = STOREY;         // a 1-storey drop is safe; falling MORE than a floor starts to hurt
const FALL_DMG_PER_M = 9;         // scales so a ~5-storey fall is lethal (≥ a human's 150 HP)

/** HP a human loses from a fall: harmless up to 1 storey, then rises with height until a long fall
 *  (≈5+ storeys) is fatal — "entre más alto, más daño, hasta morir". */
export function humanFallDamage(fallDistance: number): number {
  if (fallDistance <= FALL_SAFE) return 0;
  return Math.round((fallDistance - FALL_SAFE) * FALL_DMG_PER_M);
}

const IMPACT_MIN = 26;            // m/s — a fast ram; CRUISE (18) is safe, BOOST (40) hurts
const IMPACT_BLOCK_MIN = 0.6;     // fraction of the intended move that was blocked (a real wall hit)
const IMPACT_DMG_PER_MS = 6;      // HP lost per m/s over the threshold

/** HP the drone loses ramming a wall/object: only when it was moving fast AND got hard-blocked. */
export function droneImpactDamage(speed: number, blockedFrac: number): number {
  if (speed < IMPACT_MIN || blockedFrac < IMPACT_BLOCK_MIN) return 0;
  return Math.round((speed - IMPACT_MIN) * IMPACT_DMG_PER_MS);
}
