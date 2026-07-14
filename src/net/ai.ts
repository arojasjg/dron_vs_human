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
}
export interface AiTarget {
  id: number; x: number; y: number; z: number; vx?: number; vz?: number;
  hp?: number; maxHp?: number;              // threat scoring: finish the wounded
  firing?: boolean;                         // threat scoring: punish whoever's shooting
  aimX?: number; aimZ?: number;             // the target's aim dir (XZ) — bots dodge when it points at them
}
export interface AiFire { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; targetId: number; blind?: boolean; }
/** A NOISE the swarm can hear: origin XZ + `loud` = the radius (m) within which a bot perceives it. */
export interface AiNoise { x: number; z: number; loud: number; }
/** A bot RELEASES a grenade (an aerial bomb) at (x,y,z) — it falls under gravity and explodes below. */
export interface AiDrop { id: number; x: number; y: number; z: number; targetId: number; }
/** A KAMIKAZE reached its target and self-detonates at (x,y,z) — a contact explosion on the player. */
export interface AiBoom { id: number; x: number; y: number; z: number; targetId: number; }

/** Per-archetype base stats. speed m/s · hp bullets-to-kill · hold stand-off (m) · fireCd s · high hover height (m). */
export const ARCHETYPES: Record<AiKind, { speed: number; hp: number; hold: number; fireCd: number; high: number }> = {
  chaser:   { speed: 10.5, hp: 2,  hold: 5,  fireCd: 1.7, high: 3 },   // fast + fragile — rushes into your face
  gunner:   { speed: 6.0,  hp: 3,  hold: 24, fireCd: 0.9, high: 8 },   // kites at range, fires often
  diver:    { speed: 9.0,  hp: 3,  hold: 9,  fireCd: 1.3, high: 18 },  // hovers HIGH, dives as it closes
  tank:     { speed: 3.8,  hp: 9,  hold: 18, fireCd: 0.8, high: 6 },   // armored suppressor, frontal shield
  kamikaze: { speed: 13.0, hp: 2,  hold: 0,  fireCd: 0,   high: 4 },   // rams straight in + detonates, no gun
  support:  { speed: 7.0,  hp: 4,  hold: 30, fireCd: 2.2, high: 12 },  // hangs back, heals + hastens the swarm
};

const HEAL_RADIUS = 14;   // a support tops up allies within this radius
const HEAL_AMT = 1;       // hp restored per heal pulse
const HEAL_CD = 1.2;      // seconds between a support's heal pulses (reuses the grenade timer slot)
const SEP_RADIUS = 5;     // anti-clumping: bots within this push apart (wide enough to break the ball-on-top pile-up)
const AIM_COS = 0.965;    // how tightly the target's aim must point at a bot to trigger a dodge

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

/** Wave size grows ~×1.6 each wave — NO cap ("cada vez más drones"). Pure. */
export function waveSize(wave: number, base = 5): number {
  return Math.ceil(base * Math.pow(1.6, Math.max(0, wave)));
}

/** Per-wave difficulty ramps (pure, bounded — BRUTAL: higher caps so late waves are punishing). */
export function speedScale(wave: number): number { return 1 + Math.min(1.6, Math.max(0, wave) * 0.08); }
export function fireCdScale(wave: number): number { return 1 / (1 + Math.min(2.2, Math.max(0, wave) * 0.1)); }
export function hpBonus(wave: number): number { return Math.floor(Math.max(0, wave) / 2); }
/** Aim spread (radians of jitter added to the fire dir) — TIGHTENS with the wave, so late drones are deadly. */
export function spread(wave: number): number { return Math.max(0.008, 0.2 - Math.max(0, wave) * 0.025); }

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
  /** Swarm blackboard: where ANY bot last saw or heard a target. Never-perceived bots advance to it (so the wave
   *  converges on the last contact instead of idling), and it's the low-confidence belief fallback. t < 0 = none. */
  private lastContact = { x: 0, z: 0, t: -1 };
  readonly RANGE = 44;   // fire + engagement range (m)
  readonly PROJ = 90;    // assumed round speed used for aim lead
  readonly GREN_CD = 4;    // seconds between a bomber's grenade drops (divers + gunners, aggressive)
  readonly DROP_RANGE = 16; // XZ distance under which a bomber releases a grenade over the target

  get list(): readonly AiBot[] { return [...this.bots.values()]; }
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
    const n = waveSize(w);
    const bonus = hpBonus(w);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + w;
      const kind = pickKind(rng, w);
      const st = ARCHETYPES[kind];
      const hp = st.hp + bonus;
      this.bots.set(this.nextId, {
        id: this.nextId, x: cx + Math.cos(a) * radius, y: y + st.high * 0.5, z: cz + Math.sin(a) * radius,
        hp, maxHp: hp, cd: rng() * st.fireCd, gcd: rng() * this.GREN_CD, kind, seed: rng(), orbit: rng() < 0.5 ? 1 : -1,
        lsx: cx, lsz: cz, lsT: -1, ba: 0, bt: -1, fx: 0, fz: 0,
      });
      this.nextId++;
    }
    return n;
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
    noises: readonly AiNoise[] = [],
  ): AiFire[] {
    this.t += dt;
    const fires: AiFire[] = [];
    if (targets.length === 0) return fires;
    const sp = speedScale(this.wave), fcd = fireCdScale(this.wave), sprd = spread(this.wave);

    // Spatial hash of bot positions (built once per tick) → O(n) neighbour lookups for separation + support heal.
    const CELL = 6;
    const hash = (gx: number, gz: number) => ((gx * 73856093) ^ (gz * 19349663)) | 0;
    const buckets = new Map<number, AiBot[]>();
    for (const b of this.bots.values()) {
      const k = hash(Math.floor(b.x / CELL), Math.floor(b.z / CELL));
      let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr); } arr.push(b);
    }
    const neighborsOf = (b: AiBot): AiBot[] => {
      const out: AiBot[] = []; const cx = Math.floor(b.x / CELL), cz = Math.floor(b.z / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const arr = buckets.get(hash(gx, gz)); if (!arr) continue;
        for (const o of arr) if (o !== b) out.push(o);
      }
      return out;
    };

    for (const b of this.bots.values()) {
      const a = ARCHETYPES[b.kind];
      // --- PERCEPTION: hearing first, then sight (sight wins). Belief anchor = lsx/lsz, accuracy = ba. ---
      const ni = pickAudible(b.x, b.z, noises);
      if (ni >= 0) { b.lsx = noises[ni].x; b.lsz = noises[ni].z; b.lsT = this.t; b.ba = 0.6; } // heard → approximate fix
      const t = targets[pickThreatTarget(b.x, b.z, targets)];  // the target we test LOS / fire against
      const aimY = t.y + 1;
      const canSee = los(b.x, b.y, b.z, t.x, aimY, t.z);
      const distXZ = Math.hypot(t.x - b.x, t.z - b.z) || 1e-3;  // true distance (fire/boom/drop gates)
      if (canSee) { b.lsx = t.x; b.lsz = t.z; b.lsT = this.t; b.ba = 1; b.bt = t.id; } // saw → exact fix, bind the target
      const perceived = b.lsT >= 0;
      if (canSee || ni >= 0) { this.lastContact.x = b.lsx; this.lastContact.z = b.lsz; this.lastContact.t = this.t; } // share it
      else if (!perceived && this.lastContact.t >= 0) { b.lsx = this.lastContact.x; b.lsz = this.lastContact.z; } // never perceived → head to the swarm's last contact

      // BELIEF GOAL: the (drifting) point the bot pursues — exact when fresh, imprecise & seed-fanned when stale.
      const age = perceived ? this.t - b.lsT : (this.lastContact.t >= 0 ? this.t - this.lastContact.t : 0);
      const acc = perceived ? beliefAccuracy(b.ba, age) : 0.2;
      const [gx, gz] = beliefGoal(b.lsx, b.lsz, b.seed, this.t, acc);
      const gdx = gx - b.x, gdz = gz - b.z, gDist = Math.hypot(gdx, gdz) || 1e-3;
      b.fx = gdx / gDist; b.fz = gdz / gDist;                   // face where it BELIEVES you are (shield/aim)
      const fresh = perceived && age < 1.5;                     // saw/heard recently → engage; else search
      const hold = a.hold * holdMult(b.seed);                   // per-bot stand-off → LAYERED ring, no ball

      const dir = seekDir(b.x, b.y, b.z, gx, aimY, gz);
      const [ox, oz] = orbitDir(gdx, gdz, b.orbit);
      const jk = jink(b.seed, this.t);
      // ENCIRCLE: each bot owns a bearing slot on the hold ring around the BELIEF → the swarm surrounds you.
      const bearing = b.seed * Math.PI * 2;
      const ringX = gx + Math.cos(bearing) * hold, ringZ = gz + Math.sin(bearing) * hold;
      const rdx = ringX - b.x, rdz = ringZ - b.z, rl = Math.hypot(rdx, rdz) || 1e-3;

      const lowHp = b.kind !== "kamikaze" && b.hp <= Math.max(1, a.hp * 0.34); // hurt → retreat
      const aimedAt = canSee && t.aimX !== undefined && beingAimedAt(b.x, b.z, t.x, t.z, t.aimX, t.aimZ ?? 0);

      let mvx: number, mvz: number;
      if (b.kind === "kamikaze") {                        // ram straight in toward the belief
        mvx = dir[0]; mvz = dir[2];
      } else if (lowHp) {                                 // hurt → back off + strafe (self-preservation)
        mvx = ox - dir[0] * 0.8; mvz = oz - dir[2] * 0.8;
      } else if (!fresh) {                                // SEARCH: sweep the drifting belief ring, orbit-heavy → FAN OUT
        mvx = (rdx / rl) * 0.6 + ox * 0.7 + dir[0] * 0.25;
        mvz = (rdz / rl) * 0.6 + oz * 0.7 + dir[2] * 0.25;
      } else if (gDist > hold) {                          // approach: encircle SLOT dominant + goal-seek + weave
        mvx = (rdx / rl) * 0.75 + dir[0] * 0.5 + ox * 0.45 * jk;
        mvz = (rdz / rl) * 0.75 + dir[2] * 0.5 + oz * 0.45 * jk;
      } else {                                            // in the pocket → ORBIT-dominant + gentle hold-range drift
        const adj = gDist < hold * 0.6 ? -0.8 : (gDist > hold * 1.1 ? 0.5 : 0);
        mvx = ox * 1.2 + dir[0] * adj; mvz = oz * 1.2 + dir[2] * adj;
      }
      if (aimedAt) { mvx += ox * 1.2; mvz += oz * 1.2; }   // DODGE when the crosshair is on us

      const [sepx, sepz] = separation(b.x, b.z, neighborsOf(b), SEP_RADIUS); // anti-clumping
      mvx += sepx * 1.4; mvz += sepz * 1.4;                // stronger push → they layer around you, not stack

      const ml = Math.hypot(mvx, mvz) || 1;
      const speed = a.speed * sp;
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
      else {
        const highMul = b.kind === "diver" ? Math.max(0.15, Math.min(1, gDist / 25)) : 1; // dive by BELIEF range
        wantY = eyeY + a.high * highMul;
        if (!canSee && perceived) wantY += 5;             // rise to see over the wall toward the believed spot
      }
      if (blocked) wantY = Math.min(45, Math.max(wantY, b.y + 8)); // hit something → climb over it (cap ~45 m)
      let ny = b.y + (wantY - b.y) * Math.min(1, dt * 2.2);
      if (ny < b.y && solid(b.x, ny, b.z)) ny = b.y;      // descending into a roof → rest on it, don't sink through
      b.y = ny;
      if (b.y < 2) b.y = 2;

      // FIRE. With real SIGHT: a LED, jittered, LEADING shot (unchanged). WITHOUT sight but with a FRESH HEARD
      // belief: a gunner/tank may OCCASIONALLY spray blind SUPPRESSION toward the belief — no lead, wide spread,
      // marked `blind` so the game side deals damage only if it can actually see (no wallhack), just pressure.
      b.cd -= dt;
      const heardBelief = b.ba < 1 && perceived && age < 1.5; // a recent noise fix we haven't confirmed by sight
      if (b.kind !== "kamikaze" && canSee && shouldFire(distXZ, b.cd, this.RANGE)) {
        b.cd = a.fireCd * fcd;
        const aim = leadAim(b.x, b.y, b.z, t.x, aimY, t.z, t.vx ?? 0, t.vz ?? 0, this.PROJ);
        const fdx = aim[0] + (aimRng() - 0.5) * 2 * sprd;
        const fdy = aim[1] + (aimRng() - 0.5) * 2 * sprd;
        const fdz = aim[2] + (aimRng() - 0.5) * 2 * sprd;
        const fl = Math.hypot(fdx, fdy, fdz) || 1;
        fires.push({ id: b.id, x: b.x, y: b.y, z: b.z, dx: fdx / fl, dy: fdy / fl, dz: fdz / fl, targetId: t.id });
      } else if (!canSee && shouldSuppress(b.kind, heardBelief, b.cd) && aimRng() < 0.15) {
        b.cd = a.fireCd * fcd;
        const aim = seekDir(b.x, b.y, b.z, gx, aimY, gz);   // toward the HEARD point, no velocity lead
        const w = sprd * 3;                                 // sprays a rough area, doesn't track
        const fdx = aim[0] + (aimRng() - 0.5) * 2 * w, fdy = aim[1] + (aimRng() - 0.5) * 2 * w, fdz = aim[2] + (aimRng() - 0.5) * 2 * w;
        const fl = Math.hypot(fdx, fdy, fdz) || 1;
        fires.push({ id: b.id, x: b.x, y: b.y, z: b.z, dx: fdx / fl, dy: fdy / fl, dz: fdz / fl, targetId: b.bt >= 0 ? b.bt : t.id, blind: true });
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
        applyHeal(b.x, b.z, neighborsOf(b), HEAL_RADIUS, HEAL_AMT);
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

  clear(): void { this.bots.clear(); this.wave = 0; this.nextId = 1; this.t = 0; this.lastContact = { x: 0, z: 0, t: -1 }; }
}
