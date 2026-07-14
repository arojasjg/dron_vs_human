// Pure co-op survival rules: how long a downed soldier waits to respawn, when the session is over, whether a
// shot is blocked (walls / smoke), and where a wave spawns. Kept free of three.js / the network so they
// unit-test directly.
import { rayHitsSphere } from "./weapons";

/** A live smoke cloud: a sphere that blocks line of sight (both ways) until `until`. */
export interface SmokeCloud { x: number; y: number; z: number; r: number; until: number; }

/** Respawn wait in seconds after a death: 10 s base, +5 s for every PREVIOUS death — "entre más muere, más
 *  espera". `deaths` is the running death count INCLUDING the one just taken (1 → 10 s, 2 → 15 s, 3 → 20 s…). */
export function respawnDelay(deaths: number): number {
  return 10 + Math.max(0, deaths - 1) * 5;
}

/** Team wipe: true when there is at least one player and EVERY player's hp is ≤ 0. Pure. */
export function allDead(hps: readonly number[]): boolean {
  return hps.length > 0 && hps.every((h) => h <= 0);
}

/** May a match (re)start now? Yes from the menu/lobby, and yes as a RESTART once the current match is over —
 *  but never a duplicate begin while a match is still live (which would rebuild the world mid-fight). Pure —
 *  the same predicate gates both the host's own beginMatch and a peer acting on the host's `begin` broadcast. */
export function canBeginMatch(phase: "menu" | "lobby" | "playing", matchOver: boolean): boolean {
  return phase !== "playing" || matchOver;
}

/** A shot at a target is BLOCKED when a wall sits nearer than the target along the ray (beyond a small
 *  edge margin so a wall flush behind the target doesn't eat the hit). Keeps bullets from passing through
 *  walls to hit a drone. Pure. */
export function wallBlocks(targetDist: number, wallDist: number, margin = 0.6): boolean {
  return wallDist < targetDist - margin;
}

/** Does an ACTIVE smoke cloud sit on the sightline a→b, obscuring it? (blocks LOS in BOTH directions). Pure —
 *  reuses rayHitsSphere: the segment passes within a cloud's radius of its centre, no farther than b. */
export function smokeOccludes(
  clouds: readonly SmokeCloud[], now: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  for (const c of clouds) {
    if (c.until <= now) continue; // expired
    if (rayHitsSphere(ax, ay, az, dx, dy, dz, c.x, c.y, c.z, dist, c.r)) return true;
  }
  return false;
}

/** Where an enemy wave spawns: a ring around the CITY CENTRE at a radius PAST the city's half-extent, so the
 *  drones appear OUTSIDE the city and fly in (not popping in on top of the player). `cityX1/cityZ1` are the
 *  city's voxel extents; `voxel` metres/voxel. Pure. */
export function perimeterSpawn(cityX1: number, cityZ1: number, voxel: number, margin = 10): { cx: number; cz: number; r: number } {
  return {
    cx: cityX1 * 0.5 * voxel,
    cz: cityZ1 * 0.5 * voxel,
    r: Math.max(cityX1, cityZ1) * 0.5 * voxel + margin,
  };
}

// ---- Bandages (channeled self-heal) --------------------------------------------------------------
export const BANDAGE_DUR = 2;    // seconds you must hold still to apply a bandage
export const BANDAGE_HEAL = 40;  // HP restored per bandage
export const BANDAGE_MAX = 3;    // bandages carried (refilled at base / on respawn)

/** Advances a bandage channel. `active` = still holding the key AND allowed to heal (has a bandage, hurt,
 *  standing still, not firing, not just hit). Not active → the channel RESETS (interrupted). Reaching `dur`
 *  returns `done` (apply the heal, consume a bandage) and resets. Pure. */
export function bandageStep(t: number, active: boolean, dt: number, dur = BANDAGE_DUR): { t: number; done: boolean } {
  if (!active) return { t: 0, done: false };
  const nt = t + dt;
  if (nt >= dur) return { t: 0, done: true };
  return { t: nt, done: false };
}

/** Cardinal directions an enemy wave can arrive from, in the rotation order (wave 0=N, 1=S, 2=E, 3=O, …). */
export type Cardinal = "N" | "S" | "E" | "O";
export const WAVE_DIRS: Cardinal[] = ["N", "S", "E", "O"];

/** Where the next enemy WAVE spawns: a single cluster point just OUTSIDE one cardinal edge of the city
 *  (not a full ring around it), rotating N→S→E→O by wave so each wave comes from a different side and flies
 *  in. Convention matches the minimap (bearing 0 = +Z): N=−Z, S=+Z, E=+X, O=−X. `margin` voxels out sits in
 *  the clear band inside the forest ring. Pure. */
export function cardinalSpawn(
  cityX1: number, cityZ1: number, voxel: number, wave: number, margin = 20,
): { cx: number; cz: number; dir: Cardinal } {
  const dir = WAVE_DIRS[((wave % 4) + 4) % 4];
  const midX = cityX1 * 0.5 * voxel, midZ = cityZ1 * 0.5 * voxel;
  const off = margin * voxel;
  switch (dir) {
    case "N": return { cx: midX, cz: -off, dir };                       // north edge (−Z)
    case "S": return { cx: midX, cz: cityZ1 * voxel + off, dir };       // south edge (+Z)
    case "E": return { cx: cityX1 * voxel + off, cz: midZ, dir };       // east edge (+X)
    default:  return { cx: -off, cz: midZ, dir };                       // west edge (−X)
  }
}

/** Where a PLAYER spawns, scaled to the map size + player count. Points sit in the CLEAR perimeter band just
 *  outside the city footprint (inside the forest ring → never inside a building), facing the centre. In PvP,
 *  team 0 takes the WEST band and team 1 the EAST band (so drone-vs-drone / human-vs-human start apart); a
 *  null team (co-op) is spread around all four sides. `idx` = net-id-1, spread over `slots` (the preset's
 *  target player count); more than `slots` joins wrap (modulo) — a soft overlap, never a wall spawn. Pure.
 *  `offset` is the band distance outside the city edge in voxels (well inside the 48-voxel forest margin). */
export function playerSpawn(
  cityX1: number, cityZ1: number, voxel: number,
  team: 0 | 1 | null, idx: number, slots: number, offset = 22,
): { x: number; y: number; z: number; yaw: number } {
  const w = cityX1 * voxel, d = cityZ1 * voxel;      // city span in metres
  const off = offset * voxel;                         // clear band offset outside the city edge
  const n = Math.max(1, slots);
  const i = ((idx % n) + n) % n;                       // wrap into [0, n)
  let x: number, z: number;
  if (team === 0) { x = -off; z = ((i + 0.5) / n) * d; }          // west band
  else if (team === 1) { x = w + off; z = ((i + 0.5) / n) * d; }  // east band
  else {                                                          // co-op: spread across all four bands
    const perSide = Math.max(1, Math.ceil(n / 4));
    const u = ((Math.floor(i / 4) % perSide) + 0.5) / perSide;
    const side = i % 4;
    if (side === 0) { x = u * w; z = -off; }                      // south
    else if (side === 1) { x = w + off; z = u * d; }              // east
    else if (side === 2) { x = u * w; z = d + off; }              // north
    else { x = -off; z = u * d; }                                 // west
  }
  const yaw = Math.atan2(w * 0.5 - x, d * 0.5 - z);   // face the city centre
  return { x, y: 2, z, yaw };
}
