// Team weapon loadouts, ammo, and drone battery. Pure data + math so it unit-tests without a
// physics world, a renderer, or the network. game.ts wires these into firing/HUD/recharge.
import type { Role } from "./roles";

export type Weapon = "mg" | "grenade" | "kamikaze" | "shotgun" | "glauncher" | "net" | "sniper" | "smoke" | "swarm" | "smg" | "lmg" | "dmr"
  | "flak" | "emp" | "lockon" | "turret" | "laser";

/** How a weapon fires — game.ts maps each kind to a Projectiles call (or a self-detonation). */
export type FireKind = "bullet" | "shotgun" | "grenade" | "explosive" | "net" | "kamikaze" | "smoke" | "swarm"
  | "flak" | "emp" | "lockon" | "turret";

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
  reloadTime?: number; // seconds a reload locks out firing (override; default derived in reloadDuration)
  spread?: { base: number; perShot: number; max: number; decay: number; adsMul: number }; // radians; decay rad/s; adsMul scales spread while scoped
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  // Drone arsenal — light: rapid MG, a FEW grenades, and a one-shot kamikaze self-detonation.
  mg:        { name: "Metralleta",    icon: "🔫", fire: "bullet",    cooldown: 0.08, magSize: 40, maxReserve: 200, playerDmg: 11, spread: { base: 0.006, perShot: 0.007, max: 0.055, decay: 0.09, adsMul: 0.3 } },
  grenade:   { name: "Granada",       icon: "💣", fire: "grenade",   cooldown: 1.2,  magSize: 2,  maxReserve: 4 },
  kamikaze:  { name: "Kamikaze",      icon: "☢️", fire: "kamikaze",  cooldown: 0.0,  magSize: 1,  maxReserve: 0 },
  // Human arsenal — MG, spread shotgun, explosive grenade launcher, a net to catch a drone, and a
  // scoped bolt-action sniper: slow + small mag, but one clean hit downs a drone (80 HP) at any range.
  shotgun:   { name: "Escopeta",      icon: "🎯", fire: "shotgun",   cooldown: 0.8,  magSize: 6,  maxReserve: 30, pellets: 9, playerDmg: 50 },
  glauncher: { name: "Lanzagranadas", icon: "🎆", fire: "explosive", cooldown: 1.0,  magSize: 4,  maxReserve: 12 },
  net:       { name: "Lanzarredes",   icon: "🕸️", fire: "net",       cooldown: 2.5,  magSize: 2,  maxReserve: 4 }, // DORMANT: replaced by the swarm in the human loadout
  sniper:    { name: "Francotirador", icon: "🔭", fire: "bullet",    cooldown: 1.3,  magSize: 5,  maxReserve: 20, playerDmg: 85, scope: true, zoomMags: [5, 10], aiRanges: [70, 110], botDmg: 3, bulletSpeed: 340, boltAction: true, spread: { base: 0.0, perShot: 0.0, max: 0.0, decay: 1.0, adsMul: 0.0 } },
  smoke:     { name: "Granada de humo", icon: "💨", fire: "smoke",   cooldown: 3.0,  magSize: 2,  maxReserve: 4 }, // deploys a sightline-blocking cloud
  swarm:     { name: "Enjambre",      icon: "🐝", fire: "swarm",     cooldown: 6.0,  magSize: 1,  maxReserve: 3 }, // ~5 homing interceptor mini-drones
  // Class weapons — assigned per class (roles.ts), not by role. All fire "bullet" so they reuse the
  // existing hitscan/broadcast path (no new net message type). Their identities live in the stats:
  smg:       { name: "Subfusil",      icon: "⚡", fire: "bullet",    cooldown: 0.05, magSize: 30,  maxReserve: 240, playerDmg: 8,  botDmg: 1, spread: { base: 0.010, perShot: 0.010, max: 0.090, decay: 0.14, adsMul: 0.4 } }, // scout/interceptor: shreds up close, useless far (falloff)
  lmg:       { name: "Ametralladora", icon: "💢", fire: "bullet",    cooldown: 0.10, magSize: 100, maxReserve: 300, playerDmg: 15, botDmg: 2, spread: { base: 0.007, perShot: 0.008, max: 0.075, decay: 0.06, adsMul: 0.3 } }, // heavy: sustained suppression, huge mag
  dmr:       { name: "Tiro medido",   icon: "🎖️", fire: "bullet",    cooldown: 0.45, magSize: 12,  maxReserve: 72,  playerDmg: 45, botDmg: 2, scope: true, zoomMags: [3], aiRanges: [55], bulletSpeed: 240, spread: { base: 0.004, perShot: 0.003, max: 0.020, decay: 0.50, adsMul: 0.1 } }, // marksman/artillery: semi-auto punch between mg and sniper
  // Anti-drone soldier tools — the answer to "hard to resist the AI swarm": AREA, CONTROL and AUTOMATION.
  flak:      { name: "Cañón Flak",    icon: "🎇", fire: "flak",     cooldown: 1.1,  magSize: 3,   maxReserve: 12 }, // airbursts among clustered drones — big AoE vs the swarm
  emp:       { name: "Granada EMP",   icon: "🌀", fire: "emp",      cooldown: 5.0,  magSize: 2,   maxReserve: 4 },  // stuns/disables every drone in radius for a few seconds (crowd control)
  lockon:    { name: "Misil buscador", icon: "🛰️", fire: "lockon",  cooldown: 2.4,  magSize: 2,   maxReserve: 8 },  // homing missile that hunts the drone you aim at (kills evasive fliers)
  turret:    { name: "Torreta",       icon: "🗼", fire: "turret",   cooldown: 14.0, magSize: 1,   maxReserve: 1 },  // SCARCE auto-sentry: only 2 per resupply, long redeploy, capped active — the engineer's tool
  // Drone PvP variety (NOT given to the AI — the swarm stays as-is): a rapid laser beam.
  laser:     { name: "Láser",         icon: "🔺", fire: "bullet",   cooldown: 0.03, magSize: 160, maxReserve: 320, playerDmg: 5, botDmg: 1, bulletSpeed: 400, spread: { base: 0.003, perShot: 0.0025, max: 0.025, decay: 0.16, adsMul: 0.5 } }, // fast, low-damage beam — a drone's dogfight weapon
};

export const TRACER_LIFE = 1.5; // seconds a bullet tracer lives (projectile.ts) → reach = bulletSpeed × life

/** How far a bullet weapon can DAMAGE a co-op bot along the shot line. A SCOPED weapon aimed down its
 *  sight uses its tuned per-zoom `aiRanges`; fired from the hip it stays short (the scope is its range).
 *  A non-scoped auto weapon reaches as far as its TRACER visibly travels (bulletSpeed × TRACER_LIFE), so
 *  a round that visibly strikes a drone actually hurts it — no more "hits but deals nothing". Pure. */
export function botHitRange(spec: WeaponSpec, scoped: boolean, zoomLevel: number): number {
  const r = spec.aiRanges;
  if (r && r.length) return scoped ? r[Math.min(zoomLevel, r.length - 1)] : 40; // scoped weapon: hip-fire deliberately short
  return (spec.bulletSpeed ?? 120) * TRACER_LIFE;                                // non-scoped: damage reaches the tracer's travel
}

/** Total half-angle (radians) of the shot cone: the weapon's base + accumulated bloom, tightened while
 *  scoped (adsMul). No spread spec → 0 (pinpoint). Pure. */
export function spreadAngle(spec: WeaponSpec, bloom: number, scoped: boolean): number {
  const s = spec.spread;
  if (!s) return 0;
  return (s.base + bloom) * (scoped ? s.adsMul : 1);
}

/** Bloom AFTER a shot: grows by perShot, capped at max. No spec → 0. Pure. */
export function addBloom(spec: WeaponSpec, bloom: number): number {
  const s = spec.spread;
  return s ? Math.min(s.max, bloom + s.perShot) : 0;
}

/** Bloom after `dt` seconds of not shooting: decays toward 0 at `decay` rad/s. No spec → 0. Pure. */
export function decayBloom(spec: WeaponSpec, bloom: number, dt: number): number {
  const s = spec.spread;
  return s ? Math.max(0, bloom - s.decay * Math.max(0, dt)) : 0;
}

/** Perturb a (not-necessarily-unit) direction by a random offset within a cone of half-angle `angle`
 *  (radians), using r1,r2 in [0,1). Returns a UNIT vector; angle<=0 returns the normalized input. The
 *  offset is uniform in the tangent disk (sqrt(r2)), rotated by t1/t2 built ⟂ to the dir. Pure. */
export function coneSpread(dx: number, dy: number, dz: number, angle: number, r1: number, r2: number): [number, number, number] {
  const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
  if (angle <= 0) return [dx, dy, dz];
  const a = r1 * 2 * Math.PI, rad = Math.tan(angle) * Math.sqrt(r2);
  const upx = Math.abs(dy) < 0.99 ? 0 : 1, upy = Math.abs(dy) < 0.99 ? 1 : 0; // up axis not parallel to dir
  let t1x = upy * dz, t1y = -upx * dz, t1z = upx * dy - upy * dx;              // cross(up, dir), upz = 0
  const t1l = Math.hypot(t1x, t1y, t1z) || 1; t1x /= t1l; t1y /= t1l; t1z /= t1l;
  const t2x = dy * t1z - dz * t1y, t2y = dz * t1x - dx * t1z, t2z = dx * t1y - dy * t1x; // cross(dir, t1)
  const ox = Math.cos(a) * rad, oy = Math.sin(a) * rad;
  const vx = dx + t1x * ox + t2x * oy, vy = dy + t1y * ox + t2y * oy, vz = dz + t1z * ox + t2z * oy;
  const vl = Math.hypot(vx, vy, vz) || 1;
  return [vx / vl, vy / vl, vz / vl];
}

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

export const HEADSHOT_MULT = 1.8; // a clean head hit rewards precise aim

/** Two-zone hit test on a target: the BODY sphere (bodyR at center) is the overall gate — unchanged from
 *  the old single-sphere test so nothing that hit before now misses; the HEAD sphere (smaller headR, headDy
 *  above center) is tested only to flag a headshot. Returns {hit, head}. Pure — reuses rayHitsSphere. */
export function hitZone(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, maxDist: number, bodyR: number, headDy: number, headR: number,
): { hit: boolean; head: boolean } {
  if (!rayHitsSphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, maxDist, bodyR)) return { hit: false, head: false };
  const head = rayHitsSphere(ox, oy, oz, dx, dy, dz, cx, cy + headDy, cz, maxDist, headR);
  return { hit: true, head };
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

/** AI chip-shot damage vs range: full `base` ≤ 20 m, linear taper to 50% at 60 m, floored at 1 so a
 *  landed hit never rounds to 0 while in range. Deterministic. Pure. */
export function aiHitDamage(base: number, dist: number): number {
  const k = dist <= 20 ? 1 : dist >= 60 ? 0.5 : 1 - 0.5 * ((dist - 20) / (60 - 20));
  return Math.max(1, base * k);
}

/** The single source of the AI "the emitted aim decides the hit" model, shared by host and peer
 *  resolution in game.ts. Returns the integer damage to apply, or 0 for a miss/blocked shot:
 *  0 if the shooter can't see the target (`sees` — the blind-suppression LOS gate) or the aim
 *  direction (dx,dy,dz, already normalized) misses the body sphere; else the range-falloff damage.
 *  Pure so the whole hit decision is unit-testable without a Game/renderer/network. */
export function aiShotDamage(
  sx: number, sy: number, sz: number, dx: number, dy: number, dz: number,
  tx: number, ty: number, tz: number, sees: boolean, base = 4, bodyR = 1.1,
): number {
  if (!sees) return 0;
  const dist = Math.hypot(tx - sx, ty - sy, tz - sz);
  if (!rayHitsSphere(sx, sy, sz, dx, dy, dz, tx, ty, tz, dist + bodyR, bodyR)) return 0;
  return Math.round(aiHitDamage(base, dist));
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

/** MANUAL magazine swap: load a fresh mag from the reserve. The rounds still in the OLD mag are DROPPED
 *  (a swapped magazine is lost) — a tactical reload wastes whatever was left. No-op with an empty reserve.
 *  Returns the new state plus how many rounds were thrown away (for HUD feedback). */
export function reloadMag(a: Ammo, magSize: number): { ammo: Ammo; lost: number } {
  if (a.reserve <= 0) return { ammo: a, lost: 0 };          // nothing to swap to → keep the current mag
  const r = Math.min(magSize, a.reserve);
  return { ammo: { mag: r, reserve: a.reserve - r }, lost: a.mag }; // fresh mag; the old mag's `a.mag` rounds are gone
}

/** Seconds a reload locks out firing. Explicit `reloadTime` wins; else derived from the weapon class:
 *  bolt-action racks slow, a huge belt (lmg) is slowest, a small shotgun tube is slow-ish, else brisk. Pure. */
export function reloadDuration(spec: WeaponSpec): number {
  if (spec.reloadTime != null) return spec.reloadTime;
  if (spec.boltAction) return 2.4;
  if (spec.magSize >= 90) return 3.2;   // lmg belt / laser cell
  if (spec.magSize <= 8) return 2.4;    // shotgun tube
  if (spec.magSize >= 30) return 1.8;   // smg / mg
  return 2.0;                            // dmr and the rest
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

export function botHpFrac(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 1;
  const f = hp / maxHp;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
