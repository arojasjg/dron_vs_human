// Shadow-map refresh policy. The sun frustum follows the player POSITION, so a stale shadow map stays
// perfectly valid while the player holds still in a static scene — re-rendering it then is pure waste
// (the pass is dominated by the static building instances in the frustum). This gates the refresh: keep
// the ~30Hz cadence whenever something actually moves (player, carved geometry, debris/drones casting
// moving shadows), but stop entirely when the scene is genuinely static — with a rare safety refresh so
// nothing can get stuck. Pure so it unit-tests; the caller owns the frame counter, the reset, and the
// `active` OR of its own signals (player-moved / grid-dirty / debris / peers).

export const SHADOW_ACTIVE_INTERVAL = 2;  // frames between refreshes while things move (~30Hz at 60fps) — unchanged from before
export const SHADOW_IDLE_INTERVAL = 60;   // static scene: one safety refresh per ~1s, otherwise skip the whole pass
export const SHADOW_MOVE_SQ = 0.02;       // m² the camera must travel since the last refresh to count as "moved" (~14cm)

/**
 * Should the shadow map be re-rendered this frame?
 * @param active   any moving shadow-caster present (player moved / grid carved / debris / remote peers).
 * @param framesSinceRefresh frames elapsed since the last refresh (caller resets to 0 on refresh).
 */
export function shouldRefreshShadows(
  active: boolean,
  framesSinceRefresh: number,
  activeInterval: number = SHADOW_ACTIVE_INTERVAL,
  idleInterval: number = SHADOW_IDLE_INTERVAL,
): boolean {
  return framesSinceRefresh >= (active ? activeInterval : idleInterval);
}
