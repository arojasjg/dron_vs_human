// Team weapon loadouts, ammo, and drone battery. Pure data + math so it unit-tests without a
// physics world, a renderer, or the network. game.ts wires these into firing/HUD/recharge.
import type { Role } from "./roles";

export type Weapon = "mg" | "grenade" | "kamikaze" | "shotgun" | "glauncher" | "net" | "sniper" | "smoke" | "swarm" | "smg" | "lmg" | "dmr";

/** How a weapon fires — game.ts maps each kind to a Projectiles call (or a self-detonation). */
export type FireKind = "bullet" | "shotgun" | "grenade" | "explosive" | "net" | "kamikaze" | "smoke" | "swarm";

export interface WeaponSpec {
  name: string;        // HUD label (Spanish)
  icon: string;        // HUD glyph
  fire: FireKind;
  cooldown: number;    // seconds between shots
  magSize: number;     // rounds per magazine
  maxReserve: number;  // spare rounds, refilled at the team base
  pellets?: number;    // shotgun: projectiles per shot
  playerDmg?: number;  // HP a direct bullet hit deals to a player (bullet/shotgun weapons)
  scope?: boolean;      // right-click aims down a scope (optical zoom inside the circle + steadier aim)
  zoomMags?: number[];  // ADS magnification factors (e.g. 5 = 5×); the wheel cycles them while scoped
  aiRanges?: number[];  // co-op: hitscan reach (m) vs bots at each matching zoom level (more zoom = longer reach)
  botDmg?: number;      // co-op: HP dealt to an AI bot per hitscan hit (default 1 — a bot has 3)
  bulletSpeed?: number; // tracer projectile speed (m/s, visual only — the hit is hitscan). Default 120
  boltAction?: boolean; // fires ONE round per trigger pull (no auto-fire while held) + a bolt-cycle reload sound
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  // Drone arsenal — light: rapid MG, a FEW grenades, and a one-shot kamikaze self-detonation.
  mg:        { name: "Metralleta",    icon: "🔫", fire: "bullet",    cooldown: 0.08, magSize: 40, maxReserve: 200, playerDmg: 11 },
  grenade:   { name: "Granada",       icon: "💣", fire: "grenade",   cooldown: 1.2,  magSize: 2,  maxReserve: 4 },
  kamikaze:  { name: "Kamikaze",      icon: "☢️", fire: "kamikaze",  cooldown: 0.0,  magSize: 1,  maxReserve: 0 },
  // Human arsenal — MG, spread shotgun, explosive grenade launcher, a net to catch a drone, and a
  // scoped bolt-action sniper: slow + small mag, but one clean hit downs a drone (80 HP) at any range.
  shotgun:   { name: "Escopeta",      icon: "🎯", fire: "shotgun",   cooldown: 0.8,  magSize: 6,  maxReserve: 30, pellets: 9, playerDmg: 50 },
  glauncher: { name: "Lanzagranadas", icon: "🎆", fire: "explosive", cooldown: 1.0,  magSize: 4,  maxReserve: 12 },
  net:       { name: "Lanzarredes",   icon: "🕸️", fire: "net",       cooldown: 2.5,  magSize: 2,  maxReserve: 4 }, // DORMANT: replaced by the swarm in the human loadout
  sniper:    { name: "Francotirador", icon: "🔭", fire: "bullet",    cooldown: 1.3,  magSize: 5,  maxReserve: 20, playerDmg: 85, scope: true, zoomMags: [5, 10], aiRanges: [70, 110], botDmg: 3, bulletSpeed: 340, boltAction: true },
  smoke:     { name: "Granada de humo", icon: "💨", fire: "smoke",   cooldown: 3.0,  magSize: 2,  maxReserve: 4 }, // deploys a sightline-blocking cloud
  swarm:     { name: "Enjambre",      icon: "🐝", fire: "swarm",     cooldown: 6.0,  magSize: 1,  maxReserve: 3 }, // ~5 homing interceptor mini-drones
  // Class weapons — assigned per class (roles.ts), not by role. All fire "bullet" so they reuse the
  // existing hitscan/broadcast path (no new net message type). Their identities live in the stats:
  smg:       { name: "Subfusil",      icon: "⚡", fire: "bullet",    cooldown: 0.05, magSize: 30,  maxReserve: 240, playerDmg: 8,  botDmg: 1 }, // scout/interceptor: shreds up close, useless far (falloff)
  lmg:       { name: "Ametralladora", icon: "💢", fire: "bullet",    cooldown: 0.10, magSize: 100, maxReserve: 300, playerDmg: 15, botDmg: 2 }, // heavy: sustained suppression, huge mag
  dmr:       { name: "Tiro medido",   icon: "🎖️", fire: "bullet",    cooldown: 0.45, magSize: 12,  maxReserve: 72,  playerDmg: 45, botDmg: 2, scope: true, zoomMags: [3], aiRanges: [55], bulletSpeed: 240 }, // marksman/artillery: semi-auto punch between mg and sniper
};

/** Melee reach test: is target (p) within `range` metres of attacker (a) AND inside the swing cone
 *  (its direction dotted with the aim `d` ≥ minDot)? Point-blank always connects. Pure. */
export function meleeHit(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, range: number, minDot: number,
): boolean {
  const rx = px - ax, ry = py - ay, rz = pz - az;
  const dist = Math.hypot(rx, ry, rz);
  if (dist > range) return false;
  if (dist < 0.35) return true;
  const dl = Math.hypot(dx, dy, dz) || 1;
  return (rx * dx + ry * dy + rz * dz) / (dist * dl) >= minDot;
}

/** Does the ray from (o) along (d) pass within `radius` of point (p), no farther than `maxDist`
 *  along the ray? Used to test whether a bullet's line of fire strikes a player. Pure. */
export function rayHitsSphere(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, maxDist: number, radius: number,
): boolean {
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  let t = (px - ox) * dx + (py - oy) * dy + (pz - oz) * dz; // project the point onto the ray
  t = Math.max(0, Math.min(maxDist, t));                    // clamp to the segment [0, maxDist]
  const cx = ox + dx * t - px, cy = oy + dy * t - py, cz = oz + dz * t - pz;
  return cx * cx + cy * cy + cz * cz < radius * radius;
}

/** Range damage multiplier for a bullet weapon: the SHOTGUN hits hard up close (its niche against a
 *  strafing drone) and fades with range; the MG is flat at all ranges. An unknown weapon → 1.0, so an
 *  older client that doesn't tag its shots degrades to the previous behaviour (version-safe). Pure. */
export function bulletFalloff(weapon: string, dist: number): number {
  if (weapon === "shotgun") {
    if (dist <= 8) return 2.4;                              // point-blank punch → out-DPSes the MG up close
    if (dist >= 30) return 0.3;                             // ineffective past mid-range
    return 2.4 + (0.3 - 2.4) * ((dist - 8) / (30 - 8));     // linear taper 2.4 → 0.3
  }
  if (weapon === "smg") {                                   // scout/interceptor niche: lethal close, feeble far
    if (dist <= 10) return 1.3;                             // out-DPSes the mg up close
    if (dist >= 28) return 0.35;                            // falls off hard past mid-range
    return 1.3 + (0.35 - 1.3) * ((dist - 10) / (28 - 10));  // linear taper 1.3 → 0.35
  }
  return 1;                                                 // mg/lmg/dmr/sniper flat; unknown → version-safe 1.0
}

const DRONE_LOADOUT: Weapon[] = ["mg", "grenade", "kamikaze"];
const HUMAN_LOADOUT: Weapon[] = ["mg", "shotgun", "glauncher", "swarm", "sniper", "smoke"];

/** The weapons a team may carry (drones deliberately get fewer — "pocas armas"). */
export function roleLoadout(role: Role): Weapon[] {
  return role === "drone" ? DRONE_LOADOUT.slice() : HUMAN_LOADOUT.slice();
}

// ---- Ammo (limited, base-refilled) --------------------------------------------------------------
export interface Ammo { mag: number; reserve: number; }

/** Fire one round: draw from the mag, auto-reload from the reserve when the mag runs dry. Returns
 *  whether a shot actually fired plus the new (immutable) state. Blocks when mag AND reserve are 0. */
export function tryFire(a: Ammo, magSize: number): { fired: boolean; ammo: Ammo } {
  if (a.mag > 0) return { fired: true, ammo: { mag: a.mag - 1, reserve: a.reserve } };
  if (a.reserve > 0) {
    const r = Math.min(magSize, a.reserve);          // reload a fresh mag from the reserve, then fire one
    return { fired: true, ammo: { mag: r - 1, reserve: a.reserve - r } };
  }
  return { fired: false, ammo: a };                  // empty — must recharge at the base
}

/** Full resupply (a full mag + a full reserve) — used both to init a weapon and to recharge at base. */
export function fullAmmo(spec: WeaponSpec): Ammo {
  return { mag: spec.magSize, reserve: spec.maxReserve };
}

// ---- Drone battery (pure) ------------------------------------------------------------------------
export const BATTERY_MAX = 100;
const BATTERY_IDLE = 0.2;    // %/s just hovering (halved → bigger effective battery)
const BATTERY_PER_MS = 0.08; // extra %/s per m/s of speed → the faster/more it moves, the more it drains

/** Battery % consumed over dt at a given speed. Faster movement drains faster; idle still trickles. */
export function batteryDrain(speed: number, dt: number): number {
  return (BATTERY_IDLE + Math.max(0, speed) * BATTERY_PER_MS) * dt;
}
