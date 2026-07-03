// Team weapon loadouts, ammo, and drone battery. Pure data + math so it unit-tests without a
// physics world, a renderer, or the network. game.ts wires these into firing/HUD/recharge.
import type { Role } from "./roles";

export type Weapon = "mg" | "grenade" | "kamikaze" | "shotgun" | "glauncher" | "net";

/** How a weapon fires — game.ts maps each kind to a Projectiles call (or a self-detonation). */
export type FireKind = "bullet" | "shotgun" | "grenade" | "explosive" | "net" | "kamikaze";

export interface WeaponSpec {
  name: string;        // HUD label (Spanish)
  icon: string;        // HUD glyph
  fire: FireKind;
  cooldown: number;    // seconds between shots
  magSize: number;     // rounds per magazine
  maxReserve: number;  // spare rounds, refilled at the team base
  pellets?: number;    // shotgun: projectiles per shot
  playerDmg?: number;  // HP a direct bullet hit deals to a player (bullet/shotgun weapons)
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  // Drone arsenal — light: rapid MG, a FEW grenades, and a one-shot kamikaze self-detonation.
  mg:        { name: "Metralleta",    icon: "🔫", fire: "bullet",    cooldown: 0.08, magSize: 40, maxReserve: 200, playerDmg: 6 },
  grenade:   { name: "Granada",       icon: "💣", fire: "grenade",   cooldown: 1.2,  magSize: 2,  maxReserve: 4 },
  kamikaze:  { name: "Kamikaze",      icon: "☢️", fire: "kamikaze",  cooldown: 0.0,  magSize: 1,  maxReserve: 0 },
  // Human arsenal — MG, spread shotgun, explosive grenade launcher, and a net to catch a drone.
  shotgun:   { name: "Escopeta",      icon: "🎯", fire: "shotgun",   cooldown: 0.8,  magSize: 6,  maxReserve: 30, pellets: 9, playerDmg: 34 },
  glauncher: { name: "Lanzagranadas", icon: "🎆", fire: "explosive", cooldown: 1.0,  magSize: 4,  maxReserve: 12 },
  net:       { name: "Lanzarredes",   icon: "🕸️", fire: "net",       cooldown: 2.5,  magSize: 2,  maxReserve: 4 },
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

const DRONE_LOADOUT: Weapon[] = ["mg", "grenade", "kamikaze"];
const HUMAN_LOADOUT: Weapon[] = ["mg", "shotgun", "glauncher", "net"];

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
const BATTERY_IDLE = 0.4;    // %/s just hovering
const BATTERY_PER_MS = 0.16; // extra %/s per m/s of speed → the faster/more it moves, the more it drains

/** Battery % consumed over dt at a given speed. Faster movement drains faster; idle still trickles. */
export function batteryDrain(speed: number, dt: number): number {
  return (BATTERY_IDLE + Math.max(0, speed) * BATTERY_PER_MS) * dt;
}
