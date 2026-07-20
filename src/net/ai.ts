// Enemy AI — a swarm of hostile drones for Co-op mode. The HOST (room creator) is the sole authority: it
// simulates every bot and broadcasts their transforms so peers just render them. The decision math is split
// into PURE functions so it unit-tests without three.js or the network.
//
// The swarm is deliberately BRUTAL: SIX archetypes (chaser / gunner / diver / tank / kamikaze / support); bots
// REMEMBER where they last saw you (hunt your last-known spot when sight breaks instead of flailing), pick the
// most THREATENING target (finish the wounded, punish whoever's shooting), ENCIRCLE you in a pincer instead of
// stacking up, SEPARATE so they don't clump, DODGE when you aim at them, RETREAT when hurt, and CLIMB to peek
// over cover. Tanks shield their front, kamikazes ram-and-detonate, supports heal the swarm. Everything ramps
// hard with the wave (faster / tougher / deadlier), and waves grow ~×1.6 with NO cap.

export type AiKind = "chaser" | "gunner" | "diver" | "tank" | "kamikaze" | "support";
export interface AiBot {
  id: number; x: number; y: number; z: number; hp: number; maxHp: number; cd: number; gcd: number;
  kind: AiKind; seed: number; orbit: number;
  lsx: number; lsz: number; lsT: number;   // BELIEF anchor: last PERCEIVED target pos (seen OR heard) + time; lsT < 0 = never perceived
  ba: number;                               // belief accuracy at the last update (1 = saw it, ~0.6 = heard it); decays with age
  bt: number;                               // believed target id (bound on perception; survives losing sight → no omniscient re-pick)
  fx: number; fz: number;                   // facing (unit XZ toward the current belief) — drives the tank's shield
  okx: number; okz: number; oky: number; okT: number; // LATCHED building opening (world XZ + entry height + time); okT < 0 = none
  stun: number;                             // seconds of EMP stun remaining — while >0 the bot is disabled (no move/fire)
  sacq: number;                             // seconds of CONTINUOUS sight on the target — gates the first shot after (re)acquiring LOS
}
export interface AiTarget {
  id: number; x: number; y: number; z: number; vx?: number; vz?: number;
  hp?: number; maxHp?: number;              // threat scoring: finish the wounded
  firing?: boolean;                         // threat scoring: punish whoever's shooting
  aimX?: number; aimZ?: number;             // the target's aim dir (XZ) — bots dodge when it points at them
}
export interface AiFire { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; targetId: number; dmg: number; blind?: boolean; }
/** A NOISE the swarm can hear: origin XZ + `loud` = the radius (m) within which a bot perceives it. */
export interface AiNoise { x: number; z: number; loud: number; }
/** A bot RELEASES a grenade (an aerial bomb) at (x,y,z) — it falls under gravity and explodes below. */
export interface AiDrop { id: number; x: number; y: number; z: number; targetId: number; }
/** A KAMIKAZE reached its target and self-detonates at (x,y,z) — a contact explosion on the player. */
export interface AiBoom { id: number; x: number; y: number; z: number; targetId: number; }
/** A bot pressed against a wall on its way to a belief inside a building REQUESTS the voxel just ahead be
 *  cleared. The game side breaks it ONLY if it's glass (a window) — ai.ts is material-agnostic. */
export interface AiBreak { id: number; x: number; y: number; z: number; dx: number; dz: number; }

/** Per-archetype base stats. speed m/s · hp bullets-to-kill · hold stand-off (m) · fireCd s · high hover height (m) · dmg shot base damage. */
export const ARCHETYPES: Record<AiKind, { speed: number; hp: number; hold: number; fireCd: number; high: number; dmg: number }> = {
  chaser:   { speed: 10.5, hp: 2,  hold: 5,  fireCd: 1.7, high: 3,  dmg: 3 },   // fast + fragile — rushes into your face, chips
  gunner:   { speed: 6.0,  hp: 3,  hold: 24, fireCd: 0.9, high: 8,  dmg: 4 },   // kites at range, fires often — the ranged workhorse
  diver:    { speed: 9.0,  hp: 3,  hold: 9,  fireCd: 1.3, high: 18, dmg: 5 },   // hovers HIGH, dives as it closes — commits, hits harder
  tank:     { speed: 3.8,  hp: 9,  hold: 18, fireCd: 0.8, high: 6,  dmg: 7 },   // armored suppressor, frontal shield — a REAL threat
  kamikaze: { speed: 13.0, hp: 2,  hold: 0,  fireCd: 0,   high: 4,  dmg: 0 },   // rams straight in + detonates, no gun
  support:  { speed: 7.0,  hp: 4,  hold: 30, fireCd: 2.2, high: 12, dmg: 2 },   // hangs back, heals + hastens the swarm — barely fights
};

const HEAL_RADIUS = 14;   // a support tops up allies within this radius
const HEAL_AMT = 1;       // hp restored per heal pulse
const HEAL_CD = 1.2;      // seconds between a support's heal pulses (reuses the grenade timer slot)
const SEP_RADIUS = 5;     // anti-clumping: bots within this push apart (wide enough to break the ball-on-top pile-up)
const AIM_COS = 0.965;    // how tightly the target's aim must point at a bot to trigger a dodge

// Spatial-hash cell + key, hoisted to module scope so tick() allocates no per-frame closures. The key
// function and cell size are FROZEN: the swarm's separation sum (an order-dependent FP accumulation) is
// byte-identical only if neighbour enumeration order is unchanged, which depends on this hash + cell.
const HASH_CELL = 6;
function cellHash(gx: number, gz: number): number { return ((gx * 73856093) ^ (gz * 19349663)) | 0; }

/** Weighted archetype pick — the base trio early, with tanks / kamikazes / supports PHASING IN as waves climb.
 *  Pure given rng (draws up to twice). `wave` gates the specials so the first waves stay the classic trio. */
export function pickKind(rng: () => number, wave = 0): AiKind {
  const r = rng();
  if (wave >= 2 && r > 0.92) return "kamikaze";
  if (wave >= 3 && r > 0.86 && r <= 0.92) return "tank";
  if (wave >= 4 && r > 0.80 && r <= 0.86) return "support";
  const b = rng();
  return b < 0.45 ? "gunner" : b < 0.78 ? "chaser" : "diver";
}

/** Wave size grows ~×1.6 each wave but PLATEAUS at `cap` — the early ramp is unchanged, late waves stop
 *  exploding into the hundreds so a soldier (with the new anti-swarm tools) can actually hold. Pure. */
export function waveSize(wave: number, base = 5, cap = 60): number {
  return Math.min(cap, Math.ceil(base * Math.pow(1.6, Math.max(0, wave))));
}

/** Jittered spawn position on the wave ring: the even-ring base angle (i/n·2π + wave) nudged by up to
 *  ~±70% of the inter-bot half-spacing, and the radius by ±15%, both derived DETERMINISTICALLY from the
 *  bot's own `seed` ([0,1)) — so no extra rng draw is consumed (the stream stays byte-identical). Pure. */
export function spawnRingPos(cx: number, cz: number, i: number, n: number, wave: number, radius: number, seed: number): { x: number; z: number } {
  const base = (i / n) * Math.PI * 2 + wave;
  const angJit = (seed - 0.5) * (Math.PI / Math.max(1, n)) * 1.4;      // ≤ ~70% of the half-spacing → no overlap/gaps
  const radFrac = ((seed * 101.7) % 1);                                 // a second [0,1) value decorrelated from seed
  const r = radius * (1 + (radFrac - 0.5) * 0.30);                      // ±15% radius
  const a = base + angJit;
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
}

export type Difficulty = "easy" | "normal" | "hard";
/** Swarm difficulty as a single multiplier (>1 harder): scales wave size, speed, fire rate, accuracy, damage.
 *  normal = 1 → byte-identical to the untiered swarm. Pure. */
export function difficultyMul(d: Difficulty): number { return d === "easy" ? 0.7 : d === "hard" ? 1.35 : 1; }

/** Per-wave difficulty ramps (pure, bounded — BRUTAL: higher caps so late waves are punishing). */
export function speedScale(wave: number): number { return 1 + Math.min(1.6, Math.max(0, wave) * 0.08); }
export function fireCdScale(wave: number): number { return 1 / (1 + Math.min(2.2, Math.max(0, wave) * 0.1)); }
export function hpBonus(wave: number): number { return Math.floor(Math.max(0, wave) / 2); }
/** Aim spread (radians of jitter added to the fire dir) — TIGHTENS with the wave, so late drones are deadly. */
export function spread(wave: number): number { return Math.max(0.008, 0.2 - Math.max(0, wave) * 0.025); }
/** Continuous-sight seconds a bot must hold LOS before its FIRST shot — a fair reaction window that
 *  TIGHTENS with the wave (late drones snap on faster). Pure. */
export function acquireDelay(wave: number): number { return Math.max(0.12, 0.4 - Math.max(0, wave) * 0.03); }
/** Gentle per-wave damage ramp for AI shots — bounded so late waves sting without one-shotting. Pure. */
export function dmgScale(wave: number): number { return 1 + Math.min(0.8, Math.max(0, wave) * 0.06); }
/** Per-archetype AI shot damage at a given wave: the archetype's base × the wave ramp. Pure. */
export function archDamage(kind: AiKind, wave: number): number { return ARCHETYPES[kind].dmg * dmgScale(wave); }

/** Unit direction from (bx,by,bz) toward (tx,ty,tz); a coincident pair yields a harmless +Y. Pure. */
export function seekDir(bx: number, by: number, bz: number, tx: number, ty: number, tz: number): [number, number, number] {
  const dx = tx - bx, dy = ty - by, dz = tz - bz;
  const d = Math.hypot(dx, dy, dz);
  return d < 1e-6 ? [0, 1, 0] : [dx / d, dy / d, dz / d];
}

/** Unit XZ vector PERPENDICULAR to the approach dir (dx,dz) — the strafe/orbit tangent. sign = ±1. Pure. */
export function orbitDir(dx: number, dz: number, sign: number): [number, number] {
  const d = Math.hypot(dx, dz) || 1;
  return [(-dz / d) * sign, (dx / d) * sign];
}

/** Lateral weave factor in [-1,1] that oscillates over time (seeded per bot) → a jinking approach. Pure. */
export function jink(seed: number, t: number): number { return Math.sin(t * 2.3 + seed * 6.283); }

/** Aim direction that LEADS a moving target (predicts where it'll be when a `projSpeed` round arrives). Pure. */
export function leadAim(
  bx: number, by: number, bz: number, tx: number, ty: number, tz: number, tvx: number, tvz: number, projSpeed: number,
): [number, number, number] {
  const lead = projSpeed > 1e-3 ? Math.hypot(tx - bx, ty - by, tz - bz) / projSpeed : 0;
  return seekDir(bx, by, bz, tx + tvx * lead, ty, tz + tvz * lead);
}

/** A bot fires only when a target is within range AND its cooldown has elapsed. Pure. */
export function shouldFire(dist: number, cooldownLeft: number, range: number): boolean {
  return dist <= range && cooldownLeft <= 0;
}

/** One homing-interceptor step (used by the soldier's mini-drone swarm): accelerate the velocity TOWARD the
 *  target (via seekDir), cap it at maxSpeed, then integrate the position by dt. Returns the new pos + vel. Pure. */
export function homingStep(
  mx: number, my: number, mz: number, vx: number, vy: number, vz: number,
  tx: number, ty: number, tz: number, accel: number, maxSpeed: number, dt: number,
): { x: number; y: number; z: number; vx: number; vy: number; vz: number } {
  const [dx, dy, dz] = seekDir(mx, my, mz, tx, ty, tz);
  vx += dx * accel * dt; vy += dy * accel * dt; vz += dz * accel * dt;
  const sp = Math.hypot(vx, vy, vz);
  if (sp > maxSpeed && sp > 1e-6) { const k = maxSpeed / sp; vx *= k; vy *= k; vz *= k; }
  return { x: mx + vx * dt, y: my + vy * dt, z: mz + vz * dt, vx, vy, vz };
}

/** A bot RELEASES a grenade (bombs from above) only if it's a diver or gunner, it can see the target, it's
 *  roughly OVER the target (within `dropRange` on XZ), and its grenade cooldown has elapsed. Chasers (in your
 *  face) never bomb. Pure. */
export function shouldDrop(kind: AiKind, gcd: number, distXZ: number, canSee: boolean, dropRange: number): boolean {
  return (kind === "diver" || kind === "gunner") && canSee && gcd <= 0 && distXZ <= dropRange;
}

/** A KAMIKAZE detonates once it's basically ON its target (within `radius` on XZ and roughly level). Pure. */
export function shouldBoom(kind: AiKind, distXZ: number, distY: number, radius = 2.4): boolean {
  return kind === "kamikaze" && distXZ <= radius && Math.abs(distY) <= radius + 1.5;
}

/** Threat score for a target from a bot at (bx,bz): LOWER = better. Base = XZ distance; a WOUNDED target is
 *  much more attractive (finish it) and one that's FIRING gets bumped up the list. Pure. */
export function threatScore(bx: number, bz: number, t: AiTarget): number {
  let s = Math.hypot(t.x - bx, t.z - bz);
  if (t.hp !== undefined && t.maxHp) s -= (1 - Math.max(0, Math.min(1, t.hp / t.maxHp))) * 18; // wounded → up to −18 m
  if (t.firing) s -= 10;                                                                        // shooting at us → priority
  return s;
}

/** Index of the MOST THREATENING target (nearest, but wounded/firing outweigh raw distance). Pure. */
export function pickThreatTarget(bx: number, bz: number, targets: readonly AiTarget[]): number {
  let best = -1, bestS = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const s = threatScore(bx, bz, targets[i]);
    if (s < bestS) { bestS = s; best = i; }
  }
  return best;
}

/** Index of the nearest target on the XZ plane (or -1 if none). Pure. Used by the soldier's interceptor swarm. */
export function pickTarget(bx: number, bz: number, targets: readonly AiTarget[]): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const dx = targets[i].x - bx, dz = targets[i].z - bz, d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Is a bot at (bx,bz) inside the aim cone of a target at (tx,tz) looking along (aimX,aimZ)? Used so a bot
 *  DODGES the moment your crosshair sweeps onto it. Pure. */
export function beingAimedAt(bx: number, bz: number, tx: number, tz: number, aimX: number, aimZ: number, cosThresh = AIM_COS): boolean {
  const toBx = bx - tx, toBz = bz - tz;
  const d = Math.hypot(toBx, toBz) || 1;
  const al = Math.hypot(aimX, aimZ) || 1;
  return (toBx * aimX + toBz * aimZ) / (d * al) >= cosThresh;
}

/** Anti-clumping steering: sum a push AWAY from every neighbour within `radius` (closer = stronger). Returns
 *  an XZ vector to add to the move. Pure over the neighbour list (which the caller bounds with a spatial hash). */
export function separation(bx: number, bz: number, neighbors: readonly { x: number; z: number }[], radius: number): [number, number] {
  let sx = 0, sz = 0;
  const r2 = radius * radius;
  for (const n of neighbors) {
    const dx = bx - n.x, dz = bz - n.z, d2 = dx * dx + dz * dz;
    if (d2 > 1e-6 && d2 < r2) { const d = Math.sqrt(d2); const w = (radius - d) / radius; sx += (dx / d) * w; sz += (dz / d) * w; }
  }
  return [sx, sz];
}

/** A support heal PULSE: every ally within `radius` that's below full HP gains `amt` (clamped to maxHp).
 *  Mutates the ally objects (they ARE the bots) and returns how many were topped up. Pure over the array. */
export function applyHeal(
  sx: number, sz: number, allies: { x: number; z: number; hp: number; maxHp: number }[], radius: number, amt: number,
): number {
  let n = 0; const r2 = radius * radius;
  for (const a of allies) {
    const dx = a.x - sx, dz = a.z - sz;
    if (dx * dx + dz * dz <= r2 && a.hp < a.maxHp) { a.hp = Math.min(a.maxHp, a.hp + amt); n++; }
  }
  return n;
}

/** Belief accuracy decaying from its value at the last perception, FLOORED (SEMI-stealth: a bot never fully
 *  loses its rough idea, but a hidden/quiet target degrades its fix). Pure. */
export function beliefAccuracy(baAtUpdate: number, age: number, floor = 0.15, decay = 0.15): number {
  return Math.max(floor, Math.min(baAtUpdate, baAtUpdate - Math.max(0, age) * decay));
}

/** The point a bot actually pursues: the belief anchor when accuracy is high, drifting into a BOUNDED, seeded
 *  offset as accuracy falls (a stale belief → imprecise search that fans the swarm out instead of stacking).
 *  Read-time (no stored random-walk) so a fresh sighting snaps it back to exact. Pure. */
export function beliefGoal(lsx: number, lsz: number, seed: number, t: number, accuracy: number, maxDrift = 6): [number, number] {
  const off = (1 - Math.max(0, Math.min(1, accuracy))) * maxDrift; // less sure → wander farther (bounded)
  const ang = seed * 6.283 + t * 0.7;                              // seeded + slowly rotating → distinct per bot
  return [lsx + Math.cos(ang) * off, lsz + Math.sin(ang) * off];
}

/** A LOST-CONTACT search point around the last-seen anchor: a WIDENING ring (radius grows with `age` since the
 *  last perception, capped at `maxR`) at a per-bot SECTOR (seed) that slowly SWEEPS. So the swarm first converges
 *  on where you were last seen, then fans out to cover every approach — a deliberate sweep, not the small drift
 *  of beliefGoal. Distinct from beliefGoal: much wider reach + seed-partitioned coverage. Pure. */
export function searchPoint(lsx: number, lsz: number, seed: number, age: number, base = 2, expand = 2, maxR = 22): [number, number] {
  const r = Math.min(maxR, base + Math.max(0, age) * expand); // longer unseen → search farther out
  const ang = seed * 6.283 + Math.max(0, age) * 0.6;          // per-bot sector + a slow sweep → cover, don't sit
  return [lsx + Math.cos(ang) * r, lsz + Math.sin(ang) * r];
}

/** BUILDING ENTRY: find a nearby door/window a blocked bot can slip through. Slides ALONG the blocking wall's
 *  face (a point `wallDist` ahead) in pure ±x/±z steps along the world axis perpendicular to the dominant
 *  approach axis — voxel walls are axis-aligned, so this stays ON the wall plane instead of drifting off a
 *  thick wall's edge. Probes at fixed ENTRY heights (doors + low windows are low; probing the bot's own height
 *  would false-positive once it climbed ABOVE a wall). An opening = a clear cell IN the wall plane (a real gap).
 *  Returns [openX, openZ, entryY] of the nearest one (seed splits the swarm left/right so they fan across
 *  multiple doors), or null → the caller climbs instead. Pure over `solid`. Bounded: 2 sides × ~10 steps ×
 *  `heights` probes per call. (Trades a small chance of rounding a wall's lateral edge for robustness — the
 *  sub-voxel collision march still prevents any tunnelling regardless of where this steers.) */
const OPEN_HEIGHTS: readonly number[] = [1.5, 4.5];        // door + low-window probe heights (hoisted — no per-call array)
const SIDES_LR: readonly number[] = [1, -1], SIDES_RL: readonly number[] = [-1, 1]; // seed-split scan order (read-only)
export function openingSeek(
  bx: number, bz: number, gdx: number, gdz: number, solid: (x: number, y: number, z: number) => boolean,
  seed = 0, reach = 6, step = 0.6, heights: readonly number[] = OPEN_HEIGHTS, wallDist = 0.7,
): [number, number, number] | null {
  const gl = Math.hypot(gdx, gdz) || 1e-3;
  const fdx = gdx / gl, fdz = gdz / gl;       // forward toward the goal
  const wx = bx + fdx * wallDist, wz = bz + fdz * wallDist; // a point ON the blocking wall's face, just ahead
  // voxel walls are axis-aligned → slide along the WORLD axis perpendicular to the dominant approach axis (a pure
  // ±x or ±z sweep that stays ON the wall plane, instead of a diagonal that drifts off a thick wall's edge).
  const alongX = Math.abs(fdx) >= Math.abs(fdz);
  const px = alongX ? 0 : 1, pz = alongX ? 1 : 0;
  const sides = seed < 0.5 ? SIDES_LR : SIDES_RL; // seed → half the swarm scans left-first, half right → fan out
  for (let d = step; d <= reach; d += step) {    // nearest opening first
    for (const side of sides) {
      const sx = wx + px * side * d, sz = wz + pz * side * d; // slide ALONG the wall face → a real hole, not open air in front
      for (const hy of heights) {
        if (!solid(sx, hy, sz)) return [sx, sz, hy]; // a clear cell in the wall plane = a door/window gap
      }
    }
  }
  return null;
}

/** Index of the best AUDIBLE noise from (bx,bz): largest positive margin (loud − dist); -1 if none is within
 *  its loudness radius. A loud explosion beats a near-but-quiet footstep. Pure. */
export function pickAudible(bx: number, bz: number, noises: readonly AiNoise[]): number {
  let best = -1, bestMargin = 0;
  for (let i = 0; i < noises.length; i++) {
    const n = noises[i];
    const margin = n.loud - Math.hypot(n.x - bx, n.z - bz);
    if (margin > 0 && margin > bestMargin) { bestMargin = margin; best = i; }
  }
  return best;
}

/** Per-bot stand-off multiplier in [lo,hi] from its seed → the swarm holds at LAYERED distances (no single ring,
 *  no ball-on-top pile-up). Defaults span 1.0..1.9 so bots only ever hold at their base range OR FARTHER (they
 *  layer outward, never crowd tighter), and seed 0 = the neutral base range. Pure. */
export function holdMult(seed: number, lo = 1.0, hi = 1.9): number {
  return lo + (hi - lo) * Math.max(0, Math.min(1, seed));
}

/** Blind SUPPRESSION gate: only a gunner or tank, with a FRESH loud-noise belief and its fire cd elapsed, may
 *  spray toward a point it can't see. Every other kind (and a stale/sighted belief) needs real LOS. Pure. */
export function shouldSuppress(kind: AiKind, beliefFresh: boolean, cd: number): boolean {
  return (kind === "gunner" || kind === "tank") && beliefFresh && cd <= 0;
}

type LosFn = (bx: number, by: number, bz: number, tx: number, ty: number, tz: number) => boolean;

/** Host-side swarm simulation: spawn escalating waves, drive each bot with archetype behaviour + memory +
 *  coordination, emit fire / grenade / detonation events. Deliberately three.js-free and network-free so
 *  tick()/spawnWave()/damageBot() are directly testable. */
export class AiSwarm {
  private readonly bots = new Map<number, AiBot>();
  private nextId = 1;
  private t = 0;
  wave = 0;
  /** Difficulty multiplier (see difficultyMul): >1 harder. 1 = normal = byte-identical to the untiered swarm. */
  difficulty = 1;
  /** Swarm blackboard: where ANY bot last saw or heard a target. Never-perceived bots advance to it (so the wave
   *  converges on the last contact instead of idling), and it's the low-confidence belief fallback. t < 0 = none. */
  private lastContact = { x: 0, z: 0, t: -1 };
  readonly RANGE = 44;   // fire + engagement range (m)
  readonly PROJ = 90;    // assumed round speed used for aim lead
  readonly GREN_CD = 4;    // seconds between a bomber's grenade drops (divers + gunners, aggressive)
  readonly DROP_RANGE = 16; // XZ distance under which a bomber releases a grenade over the target
  // Reused spatial-hash storage — rebuilt each tick but never reallocated (the largest per-frame GC churn in
  // the sim). Bucket arrays are recycled through `_bucketPool`; `_neighbors` is one scratch buffer whose result
  // is always consumed by its caller before the next collectNeighbors() call.
  private readonly _buckets = new Map<number, AiBot[]>();
  private readonly _bucketPool: AiBot[][] = [];
  private readonly _neighbors: AiBot[] = [];
  private _listCache: AiBot[] | null = null; // reused snapshot of bots.values() — rebuilt only on a membership change

  // Cached bot snapshot (read up to twice per host frame + by peers). Elements are LIVE bot objects mutated in
  // place by tick(), so a membership-stable cache stays current; a length mismatch vs bots.size (the ONLY way
  // membership changes here — waves only add, tick/damage only delete, never a same-size swap) rebuilds it in
  // the identical Map-insertion order → byte-identical to the old fresh-spread getter (guarded by golden AI).
  get list(): readonly AiBot[] {
    const c = this._listCache;
    if (c === null || c.length !== this.bots.size) return this._listCache = [...this.bots.values()];
    return c;
  }
  get count(): number { return this.bots.size; }
  has(id: number): boolean { return this.bots.has(id); }

  /** Seed a COARSE inward attractor (e.g. the city centre) so a fresh wave that has perceived nobody yet still
   *  advances into the map to make contact — instead of idling at its spawn point. Fills the blackboard when it's
   *  EMPTY or STALE (>3 s since the last real contact), so a recent sighting still wins (the new wave heads there)
   *  but an old fix doesn't send waves chasing a minutes-old point. Not omniscient — a fixed map point, not you. */
  seedContact(x: number, z: number): void {
    if (this.lastContact.t < 0 || this.t - this.lastContact.t > 3) { this.lastContact.x = x; this.lastContact.z = z; this.lastContact.t = this.t; }
  }

  /** Spawns the next wave on a ring around (cx,cz) near height y. Later waves are bigger (×1.6), tougher
   *  (hpBonus) and introduce the harder archetypes. Returns the number spawned. */
  spawnWave(cx: number, cz: number, radius: number, y: number, rng: () => number = Math.random): number {
    const w = this.wave++;
    const n = Math.max(1, Math.round(waveSize(w) * this.difficulty));
    const bonus = hpBonus(w);
    for (let i = 0; i < n; i++) {
      const kind = pickKind(rng, w);
      const st = ARCHETYPES[kind];
      const hp = st.hp + bonus;
      const cd = rng() * st.fireCd, gcd = rng() * this.GREN_CD, seed = rng(), orbit = rng() < 0.5 ? 1 : -1;
      const p = spawnRingPos(cx, cz, i, n, w, radius, seed); // CBT-M7: jitter spawn off the perfect ring (from seed, no extra rng draw)
      this.bots.set(this.nextId, {
        id: this.nextId, x: p.x, y: y + st.high * 0.5, z: p.z,
        hp, maxHp: hp, cd, gcd, kind, seed, orbit,
        lsx: cx, lsz: cz, lsT: -1, ba: 0, bt: -1, fx: 0, fz: 0, okx: 0, okz: 0, oky: 0, okT: -1, stun: 0, sacq: 0,
      });
      this.nextId++;
    }
    return n;
  }

  /** The 3×3 spatial-hash neighbourhood of `b` (excluding itself) written into a REUSED scratch array. The
   *  caller consumes the result immediately (separation / heal), so one buffer is safe. Enumeration order —
   *  bucket fill order (bots.values()) × the frozen gx/gz scan below — is preserved verbatim, so the
   *  separation FP sum stays byte-identical to the pre-optimization per-call-array version. */
  private collectNeighbors(b: AiBot): AiBot[] {
    const out = this._neighbors; out.length = 0;
    const cx = Math.floor(b.x / HASH_CELL), cz = Math.floor(b.z / HASH_CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const arr = this._buckets.get(cellHash(gx, gz)); if (!arr) continue;
      for (const o of arr) if (o !== b) out.push(o);
    }
    return out;
  }

  /** Advances every bot and returns the shots fired this tick. Bots are NOT omniscient: they drive off a
   *  PERCEIVED belief (updated only by real `los` sight or by an audible `noises` event), pursuing a drifting,
   *  seeded search point when the belief is stale — so a quiet/hidden target is tracked imprecisely and the
   *  swarm fans out to look. Normal fire still needs real LOS; gunners/tanks may blind-SUPPRESS a heard point
   *  (marked `blind`, damage re-gated on the game side). `aimRng` = jitter + the occasional-suppress roll;
   *  `drops`/`booms` collect bomber/kamikaze events; `solid` = wall collision; `noises` = what the swarm hears. */
  tick(
    dt: number, targets: readonly AiTarget[], los: LosFn = () => true, aimRng: () => number = Math.random,
    drops?: AiDrop[], booms?: AiBoom[], solid: (x: number, y: number, z: number) => boolean = () => false,
    noises: readonly AiNoise[] = [], breaks?: AiBreak[],
  ): AiFire[] {
    this.t += dt;
    const fires: AiFire[] = [];
    if (targets.length === 0) return fires;
    const sp = speedScale(this.wave), fcd = fireCdScale(this.wave), sprd = spread(this.wave) / this.difficulty;
    const lerpK = Math.min(1, dt * 2.2); // height-lerp factor — loop-invariant, hoisted out of the per-bot loop

    // Spatial hash of bot positions (rebuilt each tick into POOLED arrays → zero per-tick Map/array allocation).
    // Insertion order (bots.values()) and the cellHash are unchanged → neighbour enumeration, and thus the
    // separation FP sum, is byte-identical to the previous fresh-Map version.
    const buckets = this._buckets, pool = this._bucketPool;
    for (const arr of buckets.values()) { arr.length = 0; pool.push(arr); }
    buckets.clear();
    for (const b of this.bots.values()) {
      const k = cellHash(Math.floor(b.x / HASH_CELL), Math.floor(b.z / HASH_CELL));
      let arr = buckets.get(k);
      if (!arr) { arr = pool.pop() ?? []; buckets.set(k, arr); }
      arr.push(b);
    }

    for (const b of this.bots.values()) {
      const a = ARCHETYPES[b.kind];
      if (b.stun > 0) { b.stun -= dt; b.cd = Math.max(b.cd, 0.2); continue; } // EMP: disabled — no move, no fire, hovers in place
      // --- PERCEPTION: hearing first, then sight (sight wins). Belief anchor = lsx/lsz, accuracy = ba. ---
      const ni = pickAudible(b.x, b.z, noises);
      if (ni >= 0) { b.lsx = noises[ni].x; b.lsz = noises[ni].z; b.lsT = this.t; b.ba = 0.6; } // heard → approximate fix
      const t = targets[pickThreatTarget(b.x, b.z, targets)];  // the target we test LOS / fire against
      const aimY = t.y + 1;
      const canSee = los(b.x, b.y, b.z, t.x, aimY, t.z);
      const distXZ = Math.hypot(t.x - b.x, t.z - b.z) || 1e-3;  // true distance (fire/boom/drop gates)
      if (canSee) { b.lsx = t.x; b.lsz = t.z; b.lsT = this.t; b.ba = 1; b.bt = t.id; } // saw → exact fix, bind the target
      if (canSee) b.sacq = Math.min(b.sacq + dt, 2); else b.sacq = 0; // grow while continuously sighted; reset on any LOS break
      const perceived = b.lsT >= 0;
      if (canSee || ni >= 0) { this.lastContact.x = b.lsx; this.lastContact.z = b.lsz; this.lastContact.t = this.t; } // share it
      else if (!perceived && this.lastContact.t >= 0) { b.lsx = this.lastContact.x; b.lsz = this.lastContact.z; } // never perceived → head to the swarm's last contact

      // BELIEF GOAL: the (drifting) point the bot pursues — exact when fresh, imprecise & seed-fanned when stale.
      const age = perceived ? this.t - b.lsT : (this.lastContact.t >= 0 ? this.t - this.lastContact.t : 0);
      const acc = perceived ? beliefAccuracy(b.ba, age) : 0.2;
      const [gx, gz] = beliefGoal(b.lsx, b.lsz, b.seed, this.t, acc);
      const gdx = gx - b.x, gdz = gz - b.z;
      const rawG = Math.hypot(gdx, gdz), gDist = rawG || 1e-3;  // ONE hypot: gDist and the orbit tangent both use it
      b.fx = gdx / gDist; b.fz = gdz / gDist;                   // face where it BELIEVES you are (shield/aim)
      const fresh = perceived && age < 1.5;                     // saw/heard recently → engage; else search
      const hold = a.hold * holdMult(b.seed);                   // per-bot stand-off → LAYERED ring, no ball

      const dir = seekDir(b.x, b.y, b.z, gx, aimY, gz);
      const od = rawG || 1;                                     // orbitDir's OWN guard (|| 1), distinct from gDist's || 1e-3
      const ox = (-gdz / od) * b.orbit, oz = (gdx / od) * b.orbit; // strafe/orbit tangent (inlined orbitDir, no tuple + shared hypot)

      const lowHp = b.kind !== "kamikaze" && b.hp <= Math.max(1, a.hp * 0.34); // hurt → retreat
      const aimedAt = canSee && t.aimX !== undefined && beingAimedAt(b.x, b.z, t.x, t.z, t.aimX, t.aimZ ?? 0);

      let mvx: number, mvz: number;
      if (b.kind === "kamikaze") {                        // ram straight in toward the belief
        mvx = dir[0]; mvz = dir[2];
      } else if (lowHp) {                                 // hurt → back off + strafe (self-preservation)
        mvx = ox - dir[0] * 0.8; mvz = oz - dir[2] * 0.8;
      } else if (!fresh) {                                // SEARCH: converge on the last-seen spot, then fan OUT in a
        const [spx, spz] = searchPoint(b.lsx, b.lsz, b.seed, age); // WIDENING, seed-sectored sweep (cover every approach)
        const sdx = spx - b.x, sdz = spz - b.z, sl = Math.hypot(sdx, sdz) || 1e-3;
        mvx = (sdx / sl) * 0.85 + ox * 0.5;               // seek the sweep point (dominant) + orbit for lateral coverage
        mvz = (sdz / sl) * 0.85 + oz * 0.5;
      } else if (gDist > hold) {                          // approach: encircle SLOT dominant + goal-seek + weave
        // ENCIRCLE: each bot owns a bearing slot on the hold ring around the BELIEF → the swarm surrounds you.
        // Computed HERE (its only consumer) instead of for every bot every frame.
        const jk = jink(b.seed, this.t);
        const bearing = b.seed * Math.PI * 2;
        const ringX = gx + Math.cos(bearing) * hold, ringZ = gz + Math.sin(bearing) * hold;
        const rdx = ringX - b.x, rdz = ringZ - b.z, rl = Math.hypot(rdx, rdz) || 1e-3;
        mvx = (rdx / rl) * 0.75 + dir[0] * 0.5 + ox * 0.45 * jk;
        mvz = (rdz / rl) * 0.75 + dir[2] * 0.5 + oz * 0.45 * jk;
      } else {                                            // in the pocket → ORBIT-dominant + gentle hold-range drift
        const adj = gDist < hold * 0.6 ? -0.8 : (gDist > hold * 1.1 ? 0.5 : 0);
        mvx = ox * 1.2 + dir[0] * adj; mvz = oz * 1.2 + dir[2] * adj;
      }
      // BUILDING ENTRY: if a wall blocks the straight line to the belief, steer toward the nearest door/window
      // (slip through) instead of grinding up and OVER it. If no open gap is near, REQUEST a break of the voxel
      // just ahead (the game clears it only if it's glass) — so drones enter through doors or by shattering
      // windows, rather than always climbing to the roof. Latched ~1.2 s so they don't dither between openings.
      const gfx = b.fx, gfz = b.fz;                        // == gdx/gDist, gdz/gDist (already stored above — no recompute)
      // BUILDING ENTRY: a bot that BELIEVES you're near but can't SEE you is up against the building you're
      // inside. Rather than cruise overhead and climb onto the ROOF (where it can never reach you), it DROPS to
      // the door/window band, hunts the nearest opening with a wide reach, and — if none is in range — asks to
      // shatter the window ahead, pressing IN at that height. Kamikazes and the hurt opt out (ram / retreat).
      const ENTRY_Y = 1.8;                                 // door/low-window band (voxels ~1-8 → 0.25-2 m)
      const wantEntry = b.kind !== "kamikaze" && !lowHp && perceived && !canSee && gDist < 16; // near the belief but blind → you're inside
      let seekingOpening = false, entryY = 0;
      const wallAhead = wantEntry && solid(b.x + gfx * 0.9, ENTRY_Y, b.z + gfz * 0.9); // wall between us and you AT ENTRY height (not cruise)
      if (wallAhead) {
        let ok: [number, number, number] | null = null;
        if (b.okT >= 0 && this.t - b.okT < 1.2) ok = [b.okx, b.okz, b.oky];   // reuse the latched opening
        else { ok = openingSeek(b.x, b.z, gdx, gdz, solid, b.seed, 12); if (ok) { b.okx = ok[0]; b.okz = ok[1]; b.oky = ok[2]; b.okT = this.t; } } // WIDE reach → find the door along the wall
        if (ok) {
          const odx = ok[0] - b.x, odz = ok[1] - b.z, ol = Math.hypot(odx, odz) || 1e-3;
          mvx = (odx / ol) * 0.9 + gfx * 0.35;  // slide toward the opening (dominant) + a little forward through it
          mvz = (odz / ol) * 0.9 + gfz * 0.35;
          seekingOpening = true; entryY = ok[2];
        } else if (breaks) {
          breaks.push({ id: b.id, x: b.x + gfx * 0.9, y: ENTRY_Y, z: b.z + gfz * 0.9, dx: gfx, dz: gfz }); // shatter the window at door height
        }
      }

      if (aimedAt) { mvx += ox * 1.2; mvz += oz * 1.2; }   // DODGE when the crosshair is on us

      const [sepx, sepz] = separation(b.x, b.z, this.collectNeighbors(b), SEP_RADIUS); // anti-clumping
      mvx += sepx * 1.4; mvz += sepz * 1.4;                // stronger push → they layer around you, not stack

      const ml = Math.hypot(mvx, mvz) || 1;
      const speed = a.speed * sp * this.difficulty;
      // COLLISION: don't fly through walls/trees. March the move in sub-voxel steps (so a fast late-wave bot
      // can't tunnel a thin wall), sliding along whichever axis stays clear; a fully-blocked step stops the
      // horizontal advance and flags `blocked` so the bot climbs OVER the obstacle below.
      const stepX = (mvx / ml) * speed * dt, stepZ = (mvz / ml) * speed * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(stepX, stepZ) / 0.2));
      let nx = b.x, nz = b.z, blocked = false;
      for (let k = 0; k < steps; k++) {
        const tx = nx + stepX / steps, tz = nz + stepZ / steps;
        if (!solid(tx, b.y, tz)) { nx = tx; nz = tz; continue; }
        blocked = true;
        const freeX = !solid(tx, b.y, nz), freeZ = !solid(nx, b.y, tz);
        if (freeX && !freeZ) nx = tx;         // slide along X
        else if (freeZ && !freeX) nz = tz;    // slide along Z
        else break;                           // boxed in → stop, climb over
      }
      b.x = nx; b.z = nz;

      // HEIGHT: kamikaze drops to your level to ram; divers dive as they close; a blocked hunter CLIMBS to
      // peek over the cover; a bot that hit a wall/tree RISES to clear it; the rest sit at their archetype height.
      // believed target altitude: EXACT when we see it, else ground level — so an unseen/quiet player on a tower
      // isn't tracked vertically either (the belief covers Y too, not just XZ).
      const eyeY = canSee ? aimY : 2;
      let wantY: number;
      if (b.kind === "kamikaze") wantY = eyeY;
      else if (wantEntry) wantY = ENTRY_Y;                // DROP to the door/window band to go IN — never onto the roof
      else {
        const highMul = b.kind === "diver" ? Math.max(0.15, Math.min(1, gDist / 25)) : 1; // dive by BELIEF range
        wantY = eyeY + a.high * highMul;
        if (!canSee && perceived && gDist > 28) wantY += 5; // rise to peek ONLY over a DISTANT wall — never one you're inside
      }
      if (seekingOpening) wantY = entryY;                 // drop to the door/window band to fly IN, not climb over
      else if (blocked && !wantEntry) wantY = Math.min(45, Math.max(wantY, b.y + 8)); // hop a SHORT obstacle; a building gets ENTERED, not climbed
      let ny = b.y + (wantY - b.y) * lerpK;
      if (ny < b.y && solid(b.x, ny, b.z)) ny = b.y;      // descending into a roof → rest on it, don't sink through
      b.y = ny;
      if (b.y < 2) b.y = 2;

      // FIRE. With real SIGHT: a LED, jittered, LEADING shot (unchanged). WITHOUT sight but with a FRESH HEARD
      // belief: a gunner/tank may OCCASIONALLY spray blind SUPPRESSION toward the belief — no lead, wide spread,
      // marked `blind` so the game side deals damage only if it can actually see (no wallhack), just pressure.
      b.cd -= dt;
      const heardBelief = b.ba < 1 && perceived && age < 1.5; // a recent noise fix we haven't confirmed by sight
      if (b.kind !== "kamikaze" && canSee && b.sacq >= acquireDelay(this.wave) && shouldFire(distXZ, b.cd, this.RANGE)) {
        b.cd = a.fireCd * fcd / this.difficulty;
        const aim = leadAim(b.x, b.y, b.z, t.x, aimY, t.z, t.vx ?? 0, t.vz ?? 0, this.PROJ);
        const fdx = aim[0] + (aimRng() - 0.5) * 2 * sprd;
        const fdy = aim[1] + (aimRng() - 0.5) * 2 * sprd;
        const fdz = aim[2] + (aimRng() - 0.5) * 2 * sprd;
        const fl = Math.hypot(fdx, fdy, fdz) || 1;
        fires.push({ id: b.id, x: b.x, y: b.y, z: b.z, dx: fdx / fl, dy: fdy / fl, dz: fdz / fl, targetId: t.id, dmg: archDamage(b.kind, this.wave) * this.difficulty });
      } else if (!canSee && shouldSuppress(b.kind, heardBelief, b.cd) && aimRng() < 0.15) {
        b.cd = a.fireCd * fcd / this.difficulty;
        const aim = seekDir(b.x, b.y, b.z, gx, aimY, gz);   // toward the HEARD point, no velocity lead
        const w = sprd * 3;                                 // sprays a rough area, doesn't track
        const fdx = aim[0] + (aimRng() - 0.5) * 2 * w, fdy = aim[1] + (aimRng() - 0.5) * 2 * w, fdz = aim[2] + (aimRng() - 0.5) * 2 * w;
        const fl = Math.hypot(fdx, fdy, fdz) || 1;
        fires.push({ id: b.id, x: b.x, y: b.y, z: b.z, dx: fdx / fl, dy: fdy / fl, dz: fdz / fl, targetId: b.bt >= 0 ? b.bt : t.id, dmg: archDamage(b.kind, this.wave) * this.difficulty, blind: true });
      }

      b.gcd -= dt;
      // KAMIKAZE contact detonation → emit a boom and remove the (spent) bot.
      if (booms && shouldBoom(b.kind, distXZ, b.y - aimY)) {
        booms.push({ id: b.id, x: b.x, y: b.y, z: b.z, targetId: t.id });
        this.bots.delete(b.id);
        continue;
      }
      // GRENADE drop: a bomber (diver/gunner) with sight, roughly OVER the target, off cooldown → release one.
      if (drops && shouldDrop(b.kind, b.gcd, distXZ, canSee, this.DROP_RANGE)) {
        b.gcd = this.GREN_CD;
        drops.push({ id: b.id, x: b.x, y: b.y, z: b.z, targetId: t.id });
      }
      // SUPPORT heal pulse: top up nearby allies on a cooldown (reuses the grenade timer slot).
      if (b.kind === "support" && b.gcd <= 0) {
        b.gcd = HEAL_CD;
        applyHeal(b.x, b.z, this.collectNeighbors(b), HEAL_RADIUS, HEAL_AMT);
      }
    }
    return fires;
  }

  /** Applies damage to a bot; returns true (and removes it) if it died. A TANK hit from the FRONT (the shot
   *  travelling roughly OPPOSITE its facing) is shielded — 75% mitigated. Shot dir is optional (peers omit it). */
  damageBot(id: number, dmg: number, shotDirX?: number, shotDirZ?: number): boolean {
    const b = this.bots.get(id);
    if (!b) return false;
    let d = dmg;
    if (b.kind === "tank" && shotDirX !== undefined && shotDirZ !== undefined) {
      const sl = Math.hypot(shotDirX, shotDirZ) || 1;
      const dot = (shotDirX * b.fx + shotDirZ * b.fz) / sl;  // shot vs facing; frontal hit → dot ≈ −1
      if (dot < -0.3) d = Math.max(1, dmg * 0.25);            // shielded front → 75% off (always chips ≥1)
    }
    b.hp -= d;
    if (b.hp <= 0) { this.bots.delete(id); return true; }
    return false;
  }

  /** EMP: disable every bot within `r` metres (XZ) of (x,z) for `dur` seconds. Returns how many were hit.
   *  Host-authoritative — a stunned bot stops moving/firing in tick, so the frozen positions the host
   *  broadcasts show peers the disabled swarm with no extra netcode. */
  stunBots(x: number, z: number, r: number, dur: number): number {
    let n = 0; const r2 = r * r;
    for (const b of this.bots.values()) {
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz <= r2) { b.stun = Math.max(b.stun, dur); n++; }
    }
    return n;
  }

  clear(): void { this.bots.clear(); this.wave = 0; this.nextId = 1; this.t = 0; this.lastContact = { x: 0, z: 0, t: -1 }; }
}
