// Enemy AI — a swarm of hostile drones for Co-op mode. The HOST (room creator) is the sole authority: it
// simulates every bot and broadcasts their transforms so peers just render them (as remote drones). The
// decision math is split out as PURE functions so it unit-tests without three.js or the network.

export interface AiBot { id: number; x: number; y: number; z: number; hp: number; cd: number; }
export interface AiTarget { id: number; x: number; y: number; z: number; }
export interface AiFire { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; targetId: number; }

/** Unit direction from (bx,by,bz) toward (tx,ty,tz); a coincident pair yields a harmless +Y. Pure. */
export function seekDir(bx: number, by: number, bz: number, tx: number, ty: number, tz: number): [number, number, number] {
  const dx = tx - bx, dy = ty - by, dz = tz - bz;
  const d = Math.hypot(dx, dy, dz);
  return d < 1e-6 ? [0, 1, 0] : [dx / d, dy / d, dz / d];
}

/** A bot fires only when a target is within range AND its cooldown has elapsed. Pure. */
export function shouldFire(dist: number, cooldownLeft: number, range: number): boolean {
  return dist <= range && cooldownLeft <= 0;
}

/** Wave size grows with the wave number but is capped so the swarm stays affordable. Pure. */
export function waveSize(wave: number, base = 4, max = 14): number {
  return Math.min(max, base + Math.max(0, wave) * 2);
}

/** Index of the nearest target on the XZ plane (or -1 if none). Pure. */
export function pickTarget(bx: number, bz: number, targets: readonly AiTarget[]): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const dx = targets[i].x - bx, dz = targets[i].z - bz, d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Host-side swarm simulation: spawn waves, advance bots toward the nearest player, and emit fire events.
 *  Deliberately three.js-free and network-free so tick()/spawnWave()/damageBot() are directly testable. */
export class AiSwarm {
  private readonly bots = new Map<number, AiBot>();
  private nextId = 1;
  wave = 0;
  readonly SPEED = 6.5;      // m/s approach
  readonly RANGE = 42;       // fire + engagement range
  readonly HOLD = 18;        // stand-off distance it tries to keep
  readonly FIRE_CD = 1.5;    // seconds between shots
  readonly HP = 3;           // bullets to kill a bot

  get list(): readonly AiBot[] { return [...this.bots.values()]; }
  get count(): number { return this.bots.size; }
  has(id: number): boolean { return this.bots.has(id); }

  /** Spawns the next wave on a ring around (cx,cz) at height y. Returns the number spawned. */
  spawnWave(cx: number, cz: number, radius: number, y: number, rng: () => number = Math.random): number {
    const n = waveSize(this.wave++);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.wave;
      this.bots.set(this.nextId, { id: this.nextId, x: cx + Math.cos(a) * radius, y, z: cz + Math.sin(a) * radius, hp: this.HP, cd: rng() * this.FIRE_CD });
      this.nextId++;
    }
    return n;
  }

  /** Advances every bot toward its nearest target and returns the shots fired this tick. */
  tick(dt: number, targets: readonly AiTarget[]): AiFire[] {
    const fires: AiFire[] = [];
    if (targets.length === 0) return fires;
    for (const b of this.bots.values()) {
      const t = targets[pickTarget(b.x, b.z, targets)];
      const aimY = t.y + 1;
      const [dx, dy, dz] = seekDir(b.x, b.y, b.z, t.x, aimY, t.z);
      const dist = Math.hypot(t.x - b.x, t.y - b.y, t.z - b.z);
      if (dist > this.HOLD) { b.x += dx * this.SPEED * dt; b.y += dy * this.SPEED * dt; b.z += dz * this.SPEED * dt; }
      if (b.y < 2) b.y = 2; // never sink into the ground
      b.cd -= dt;
      if (shouldFire(dist, b.cd, this.RANGE)) { b.cd = this.FIRE_CD; fires.push({ id: b.id, x: b.x, y: b.y, z: b.z, dx, dy, dz, targetId: t.id }); }
    }
    return fires;
  }

  /** Applies damage to a bot; returns true (and removes it) if it died. */
  damageBot(id: number, dmg: number): boolean {
    const b = this.bots.get(id);
    if (!b) return false;
    b.hp -= dmg;
    if (b.hp <= 0) { this.bots.delete(id); return true; }
    return false;
  }

  clear(): void { this.bots.clear(); this.wave = 0; this.nextId = 1; }
}
