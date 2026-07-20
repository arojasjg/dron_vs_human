import { describe, it, expect } from "vitest";
import {
  seekDir, shouldFire, waveSize, spawnRingPos, pickTarget, orbitDir, jink, leadAim, spread,
  speedScale, fireCdScale, hpBonus, pickKind, ARCHETYPES, AiSwarm, shouldDrop, homingStep, type AiDrop, type AiKind,
  acquireDelay, type AiFire, type AiTarget,
  dmgScale, archDamage, difficultyMul,
  pickThreatTarget, beingAimedAt, separation, shouldBoom, applyHeal, type AiBoom,
  beliefAccuracy, beliefGoal, pickAudible, holdMult, shouldSuppress, searchPoint, openingSeek, type AiNoise, type AiBreak,
  AI_KINDS, kindIdx, kindFromIdx, archTint,
} from "../src/net/ai";

describe("enemy AI — pure decision helpers", () => {
  it("seekDir returns a unit vector toward the target (and a safe fallback when coincident)", () => {
    const [dx, dy, dz] = seekDir(0, 0, 0, 3, 0, 4); // (3,0,4) len 5
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5);
    expect([dx, dy, dz]).toEqual([0.6, 0, 0.8]);
    expect(seekDir(1, 1, 1, 1, 1, 1)).toEqual([0, 1, 0]); // coincident → +Y, never NaN
  });

  it("shouldFire needs both in-range AND cooldown elapsed", () => {
    expect(shouldFire(30, 0, 42)).toBe(true);
    expect(shouldFire(50, 0, 42)).toBe(false); // out of range
    expect(shouldFire(30, 0.5, 42)).toBe(false); // still cooling down
  });

  it("pickTarget returns the nearest on XZ (or -1 with no targets)", () => {
    const ts = [{ id: 1, x: 100, y: 0, z: 0 }, { id: 2, x: 5, y: 0, z: 0 }, { id: 3, x: -50, y: 0, z: 0 }];
    expect(pickTarget(0, 0, ts)).toBe(1); // index of id 2 (closest)
    expect(pickTarget(0, 0, [])).toBe(-1);
  });

  it("AI_KINDS lists all six archetypes with no duplicates", () => {
    expect(AI_KINDS).toHaveLength(6);
    expect(new Set(AI_KINDS).size).toBe(6);
    for (const k of ["chaser", "gunner", "diver", "tank", "kamikaze", "support"] as const) expect(AI_KINDS).toContain(k);
  });

  it("kindIdx/kindFromIdx round-trip, and out-of-range/NaN → a valid default", () => {
    for (const k of AI_KINDS) expect(kindFromIdx(kindIdx(k))).toBe(k);
    expect(kindFromIdx(-1)).toBe("chaser");   // legacy/underflow
    expect(kindFromIdx(99)).toBe("chaser");   // overflow
    expect(kindFromIdx(NaN)).toBe("chaser");  // garbage index
    expect(AI_KINDS).toContain(kindFromIdx(-1));
  });

  it("archTint gives every kind a DISTINCT in-range hex", () => {
    const tints = AI_KINDS.map(archTint);
    expect(new Set(tints).size).toBe(6);      // all six distinct
    for (const c of tints) { expect(typeof c).toBe("number"); expect(c).toBeGreaterThanOrEqual(0x000000); expect(c).toBeLessThanOrEqual(0xffffff); }
  });

  it("waveSize grows ~×1.6 early, then PLATEAUS at the cap (survivable late waves)", () => {
    expect(waveSize(0)).toBe(5);
    expect(waveSize(1)).toBe(8);                         // ceil(5·1.6) — early ramp unchanged
    expect(waveSize(2)).toBe(13);                        // ceil(5·1.6²)
    expect(waveSize(3)).toBeGreaterThan(waveSize(2));    // strictly grows while under the cap
    expect(waveSize(10)).toBe(60);                       // capped — no longer explodes into the hundreds
    expect(waveSize(100)).toBe(60);                      // stays at the plateau
    expect(waveSize(5, 5, 40)).toBe(40);                 // cap is configurable
    expect(waveSize(-5)).toBe(5);                        // guards a negative
  });

  it("spawnRingPos jitters off the perfect ring deterministically, staying in the ±15% radius / ±jitter angle band (CBT-M7)", () => {
    const cx = 45, cz = 0, n = 8, wave = 3, radius = 30;
    // deterministic for a given seed
    expect(spawnRingPos(cx, cz, 2, n, wave, radius, 0.37)).toEqual(spawnRingPos(cx, cz, 2, n, wave, radius, 0.37));
    // radius stays within radius·[0.85, 1.15]
    for (const seed of [0, 0.1, 0.33, 0.5, 0.75, 0.999]) {
      const p = spawnRingPos(cx, cz, 4, n, wave, radius, seed);
      const r = Math.hypot(p.x - cx, p.z - cz);
      expect(r).toBeGreaterThanOrEqual(radius * 0.85 - 1e-9);
      expect(r).toBeLessThanOrEqual(radius * 1.15 + 1e-9);
    }
    // angle stays within base ± the jitter bound (≤ π/n·0.7)
    const i = 3, base = (i / n) * Math.PI * 2 + wave, bound = (Math.PI / n) * 0.7;
    for (const seed of [0, 0.25, 0.5, 0.8, 1 - 1e-9]) {
      const p = spawnRingPos(cx, cz, i, n, wave, radius, seed);
      let da = Math.atan2(p.z - cz, p.x - cx) - base;
      while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      expect(Math.abs(da)).toBeLessThanOrEqual(bound + 1e-9);
    }
    // seed=0.5 → angJit is 0 → lands exactly on the base ring ANGLE (the radius still varies via radFrac)
    const mid = spawnRingPos(cx, cz, i, n, wave, radius, 0.5);
    let dmid = Math.atan2(mid.z - cz, mid.x - cx) - base;
    while (dmid > Math.PI) dmid -= 2 * Math.PI; while (dmid < -Math.PI) dmid += 2 * Math.PI;
    expect(dmid).toBeCloseTo(0, 9);
    // distinct seeds → distinct positions (not the perfect ring)
    const a = spawnRingPos(cx, cz, i, n, wave, radius, 0.2), b = spawnRingPos(cx, cz, i, n, wave, radius, 0.8);
    expect(a.x !== b.x || a.z !== b.z).toBe(true);
  });

  it("orbitDir is a unit vector PERPENDICULAR to the approach (the strafe tangent); sign flips it", () => {
    const [ox, oz] = orbitDir(1, 0, 1);
    expect(Math.hypot(ox, oz)).toBeCloseTo(1, 6);
    expect(ox * 1 + oz * 0).toBeCloseTo(0, 6);           // ⟂ to (1,0)
    const [mx, mz] = orbitDir(1, 0, -1);
    expect([mx, mz]).toEqual([-ox, -oz]);                // opposite sign = opposite tangent
  });

  it("jink oscillates within [-1,1]", () => {
    for (let t = 0; t < 5; t += 0.3) { const j = jink(0.5, t); expect(j).toBeGreaterThanOrEqual(-1); expect(j).toBeLessThanOrEqual(1); }
  });

  it("leadAim aims AHEAD of a moving target (and straight at a still one)", () => {
    const still = leadAim(0, 0, 0, 10, 0, 0, 0, 0, 90);
    expect(still[2]).toBeCloseTo(0, 6);                  // target still → aim straight (no z lead)
    const moving = leadAim(0, 0, 0, 10, 0, 0, 0, 5, 90); // target drifting +z
    expect(moving[2]).toBeGreaterThan(0);                // aim leads into its motion (+z)
  });

  it("dmgScale ramps gently with the wave, caps at 1.8, and guards negatives", () => {
    expect(dmgScale(0)).toBe(1);
    expect(dmgScale(-3)).toBe(1);                        // negative wave → no discount
    for (let w = 0; w < 13; w++) expect(dmgScale(w + 1)).toBeGreaterThan(dmgScale(w)); // monotonic while under the cap
    expect(dmgScale(1000)).toBe(1.8);                    // bounded — late waves sting, never one-shot
  });

  it("archDamage differentiates archetypes (tank > gunner > chaser), zeroes kamikaze, keeps gunner=4 at wave 0", () => {
    for (const w of [0, 3, 8, 20]) {
      expect(archDamage("tank", w)).toBeGreaterThan(archDamage("chaser", w));
      expect(archDamage("tank", w)).toBeGreaterThan(archDamage("gunner", w));
      expect(archDamage("kamikaze", w)).toBe(0);         // no gun — contact detonation is a separate path
    }
    expect(archDamage("gunner", 0)).toBe(4);             // preserves the old flat value at wave 0
    expect(archDamage("tank", 10)).toBeGreaterThan(archDamage("tank", 0)); // the wave ramp raises it
  });

  it("every archetype declares a non-negative dmg base", () => {
    const kinds: AiKind[] = ["chaser", "gunner", "diver", "tank", "kamikaze", "support"];
    for (const k of kinds) expect(ARCHETYPES[k].dmg).toBeGreaterThanOrEqual(0);
  });

  it("acquireDelay: a fair first-shot reaction window that TIGHTENS with the wave, floored, negative-safe", () => {
    expect(acquireDelay(0)).toBeCloseTo(0.4);
    for (let w = 0; w < 9; w++) expect(acquireDelay(w + 1)).toBeLessThan(acquireDelay(w)); // strictly tightens until the floor
    expect(acquireDelay(100)).toBe(0.12);                // floored — late waves still telegraph a little
    expect(acquireDelay(-5)).toBe(0.4);                  // guards a negative wave
  });

  it("spread TIGHTENS with the wave (deadlier late) and floors", () => {
    expect(spread(0)).toBeGreaterThan(spread(5));
    expect(spread(5)).toBeGreaterThan(spread(9));
    expect(spread(50)).toBe(0.008);                      // floored (brutal: tighter floor)
  });

  it("difficulty ramps: faster + shorter cooldown + tankier with the wave, all bounded", () => {
    expect(speedScale(10)).toBeGreaterThan(speedScale(0));
    expect(speedScale(1000)).toBeLessThanOrEqual(2.6);   // capped (brutal: higher ceiling)
    expect(fireCdScale(10)).toBeLessThan(fireCdScale(0)); // cooldown SHRINKS (fires faster)
    expect(hpBonus(0)).toBe(0);
    expect(hpBonus(6)).toBeGreaterThan(hpBonus(2));
  });

  it("shouldDrop: only a diver/gunner bombs — with sight, roughly over the target, off cooldown", () => {
    expect(shouldDrop("gunner", 0, 10, true, 16)).toBe(true);
    expect(shouldDrop("diver", 0, 10, true, 16)).toBe(true);
    expect(shouldDrop("chaser", 0, 10, true, 16)).toBe(false);  // chasers (in your face) never bomb
    expect(shouldDrop("gunner", 0, 20, true, 16)).toBe(false);  // too far off to the side → not over the target
    expect(shouldDrop("gunner", 0, 10, false, 16)).toBe(false); // no line of sight → no blind bombing
    expect(shouldDrop("gunner", 1.5, 10, true, 16)).toBe(false); // still on grenade cooldown
  });

  it("homingStep: the interceptor accelerates TOWARD the target, capped at maxSpeed, closing the distance", () => {
    const one = homingStep(0, 0, 0, 0, 0, 0, 10, 0, 0, 20, 8, 0.1); // at origin, target at +x
    expect(one.vx).toBeGreaterThan(0);          // gained velocity toward the target
    expect(one.x).toBeGreaterThan(0);           // moved toward it
    expect(Math.abs(one.vy)).toBeCloseTo(0, 6); // straight at it (no lateral)
    let p = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < 60; i++) p = homingStep(p.x, p.y, p.z, p.vx, p.vy, p.vz, 100, 0, 0, 50, 8, 0.1);
    expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThanOrEqual(8 + 1e-6); // never exceeds maxSpeed
    expect(p.x).toBeGreaterThan(20);            // closed a big chunk of the 100 m gap
  });

  it("pickKind is deterministic given rng; the archetypes have distinct roles", () => {
    expect(pickKind(() => 0)).toBe("gunner");
    expect(pickKind(() => 0.6)).toBe("chaser");
    expect(pickKind(() => 0.9)).toBe("diver");
    expect(ARCHETYPES.chaser.speed).toBeGreaterThan(ARCHETYPES.gunner.speed); // chaser is fast
    expect(ARCHETYPES.gunner.hold).toBeGreaterThan(ARCHETYPES.chaser.hold);   // gunner keeps its distance
    expect(ARCHETYPES.diver.high).toBeGreaterThan(ARCHETYPES.gunner.high);    // diver hovers higher
  });
});

describe("enemy AI — host swarm simulation", () => {
  it("spawnWave grows ~×1.6 and tags each bot with a kind, a seed and an orbit direction", () => {
    const s = new AiSwarm();
    expect(s.spawnWave(0, 0, 30, 5, () => 0.5)).toBe(5); // wave 0 → 5
    expect(s.count).toBe(5);
    expect(s.spawnWave(0, 0, 30, 5, () => 0.5)).toBe(8); // wave 1 → 8
    expect(s.count).toBe(13);
    for (const b of s.list) { expect(["chaser", "gunner", "diver"]).toContain(b.kind); expect(Math.abs(b.orbit)).toBe(1); }
  });

  it("tick: a far bot APPROACHES the target; a bot in its pocket ORBITS (moves tangentially)", () => {
    // far away → forward (X) dominates the move
    const far = new AiSwarm();
    far.spawnWave(60, 0, 0, 5, () => 0); // gunners at (60, ~9, 0)
    const b0 = far.list[0]; const fx = b0.x, fz = b0.z;
    far.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }]);
    const b1 = far.list[0];
    expect(Math.abs(b1.x - fx)).toBeGreaterThan(Math.abs(b1.z - fz)); // came toward the target (−X)
    expect(b1.x).toBeLessThan(fx);

    // exactly at the gunner hold distance (24) → the move is perpendicular to the target dir (orbit)
    const pk = new AiSwarm();
    pk.spawnWave(24, 0, 0, 5, () => 0); // gunner hold=24 → distXZ 24 = in the pocket
    const p0 = pk.list[0]; const px = p0.x, pz = p0.z;
    pk.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }]);
    const p1 = pk.list[0];
    const mvx = p1.x - px, mvz = p1.z - pz, moved = Math.hypot(mvx, mvz);
    const dot = (mvx * -1 + mvz * 0) / (moved || 1); // approach dir on XZ is (−1,0)
    expect(moved).toBeGreaterThan(0);
    expect(Math.abs(dot)).toBeLessThan(0.2);            // ⟂ to the target → strafing, not charging in
  });

  it("tick: with NO sight but a HEARD noise, a bot INVESTIGATES the sound and never fires through the wall", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0);          // bots at (60,·,0); the target at the origin is UNSEEN
    const x0 = s.list[0].x;
    const noises = [{ x: 0, z: 0, loud: 100 }]; // a loud noise at the origin — every bot hears it
    // los = never; aimRng = 0.5 so the occasional-suppress roll (needs < 0.15) never fires
    const fires = s.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }], () => false, () => 0.5, undefined, undefined, undefined, noises);
    expect(s.list[0].x).toBeLessThan(x0);       // moved TOWARD the heard point (−x) — investigating, not idling
    expect(fires.length).toBe(0);               // can't SEE it → no fire (and no blind suppression this roll)
  });

  it("tick: with distinct seeds the swarm SURROUNDS the target (spread out), it doesn't ball up on top", () => {
    const s = new AiSwarm();
    let c = 12345;
    const rng = () => { c = (c * 9301 + 49297) % 233280; return c / 233280; }; // varied → distinct seeds/orbits/holds
    s.spawnWave(0, 0, 40, 10, rng);
    const tgt = { id: 1, x: 0, y: 1, z: 0 };
    for (let i = 0; i < 150; i++) s.tick(1 / 30, [tgt], () => true); // full sight → settle around it
    const bots = s.list;
    let minD = Infinity, maxD = 0;
    for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) {
      const d = Math.hypot(bots[i].x - bots[j].x, bots[i].z - bots[j].z);
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    expect(minD).toBeGreaterThan(1.5); // no two bots stacked on the same spot (separation works)
    expect(maxD).toBeGreaterThan(12);  // they span a wide arc around the target, not a tight ball
  });

  it("tick: a wave that has perceived nobody ADVANCES to the seeded contact (city centre), not the true target", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 5, 14, () => 0);         // bots ringed at the origin (as if spawned outside)
    s.seedContact(200, 0);                      // coarse inward attractor to +x (the city centre)
    const x0 = s.list[0].x;
    for (let i = 0; i < 40; i++) s.tick(0.1, [{ id: 7, x: -500, y: 0, z: 0 }], () => false, () => 0.5); // true target is at −x, unseen
    expect(s.list[0].x).toBeGreaterThan(x0 + 3); // moved +x toward the SEED, not −x toward the real (unperceived) target
  });

  it("tick: WITHOUT sight or any noise, a bot does NOT beeline the true position (no omniscience)", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0);
    const x0 = s.list[0].x;
    // never seen, no noise, no swarm contact → it holds near its spawn belief, not charging the real target
    for (let i = 0; i < 20; i++) s.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }], () => false, () => 0.5);
    expect(Math.abs(s.list[0].x - x0)).toBeLessThan(20); // stayed near spawn (~60), didn't rush the origin
  });

  it("tick: fires a LED shot only when it can see the target, is in range, off cooldown AND past acquisition", () => {
    const s = new AiSwarm();
    s.spawnWave(20, 0, 0, 5, () => 0); // gunners in range (20 < RANGE 44), cd 0
    let fires: AiFire[] = [];
    for (let i = 0; i < 6 && fires.length === 0; i++) // a few sighted ticks so sacq clears the acquisition window
      fires = s.tick(0.1, [{ id: 7, x: 0, y: 1, z: 0, vx: 0, vz: 4 }], () => true, () => 0.5); // aimRng 0.5 → no jitter
    expect(fires.length).toBeGreaterThan(0);
    const f = fires[0];
    expect(Math.hypot(f.dx, f.dy, f.dz)).toBeCloseTo(1, 3); // a unit fire direction
    expect(f.targetId).toBe(7);
  });

  it("tick: a freshly-SIGHTED bot holds fire until it has held LOS for acquireDelay; a LOS break resets the timer", () => {
    const s = new AiSwarm();
    s.spawnWave(20, 0, 0, 5, () => 0); // gunners in range, cd 0 → only acquisition gates the first shot
    const tgt = [{ id: 7, x: 0, y: 1, z: 0 }];
    const delay = acquireDelay(s.wave);
    let t = 0;
    const fired: number[] = [];
    for (let i = 0; i < 6; i++) { t += 0.1; if (s.tick(0.1, tgt, () => true, () => 0.5).length > 0) fired.push(t); }
    expect(fired.length).toBeGreaterThan(0);             // sustained sight → it DOES engage
    expect(fired[0]).toBeGreaterThanOrEqual(delay);      // …but never before the acquisition window elapsed
    s.tick(0.1, tgt, () => false, () => 0.5);            // one blind tick → LOS break
    expect(s.list.every((b) => b.sacq === 0)).toBe(true); // the timer resets → the next peek is delayed again
  });

  it("FALSIFY: 500 ticks with flickering LOS + a moving target stay finite and above ground", () => {
    const s = new AiSwarm();
    s.spawnWave(50, 0, 40, 6); // a full ring of mixed archetypes
    let flip = false;
    for (let i = 0; i < 500; i++) {
      flip = !flip;
      const tx = Math.sin(i * 0.05) * 20; // target weaves around
      s.tick(0.05, [{ id: 1, x: tx, y: 0, z: 0, vx: Math.cos(i * 0.05) * 4, vz: 0 }], () => flip); // LOS toggles each tick
    }
    for (const b of s.list) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z)).toBe(true); // no NaN/Infinity
      expect(b.y).toBeGreaterThanOrEqual(2);                                                    // never sinks into the ground
    }
  });

  it("tick: a bomber over the target drops a grenade into the buffer, then goes on cooldown", () => {
    const s = new AiSwarm();
    s.spawnWave(10, 0, 0, 5, () => 0); // gunners at (10,·,0): gcd 0, distXZ 10 ≤ DROP_RANGE(16), in sight
    const drops: AiDrop[] = [];
    s.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }], () => true, () => 0.5, drops);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0].targetId).toBe(7);
    for (const b of s.list) expect(b.gcd).toBeGreaterThan(0); // cooldown reset after dropping
    const drops2: AiDrop[] = [];
    s.tick(0.1, [{ id: 7, x: 0, y: 0, z: 0 }], () => true, () => 0.5, drops2);
    expect(drops2.length).toBe(0); // still cooling down → no immediate second bomb
  });

  it("tick with no targets is a no-op (never throws)", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 20, 5);
    expect(s.tick(0.1, [])).toEqual([]);
  });

  it("damageBot kills at 0 hp and removes the bot", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 20, 5, () => 0); // gunner hp 3
    const id = s.list[0].id;
    expect(s.damageBot(id, 1)).toBe(false); // 3 → 2
    expect(s.damageBot(id, 5)).toBe(true);  // → dead
    expect(s.has(id)).toBe(false);
    expect(s.damageBot(999, 1)).toBe(false); // unknown id → safe
  });
});

describe("enemy AI — BRUTAL upgrade (threat / memory / coordination / archetypes)", () => {
  it("pickThreatTarget: a wounded / firing target outweighs a merely nearer one", () => {
    const ts = [{ id: 1, x: 5, y: 0, z: 0, hp: 3, maxHp: 3 }, { id: 2, x: 12, y: 0, z: 0, hp: 1, maxHp: 3, firing: true }];
    expect(pickThreatTarget(0, 0, ts)).toBe(1);   // id2: farther, but wounded + firing wins the priority
    expect(pickThreatTarget(0, 0, [{ id: 1, x: 5, y: 0, z: 0 }, { id: 2, x: 12, y: 0, z: 0 }])).toBe(0); // no meta → nearest
  });

  it("beingAimedAt: true when the target's aim points at the bot, false when it's off to the side", () => {
    expect(beingAimedAt(0, 0, 10, 0, -1, 0)).toBe(true);  // target at +x aiming −x = straight at the origin bot
    expect(beingAimedAt(0, 0, 10, 0, 0, 1)).toBe(false);  // aiming +z = perpendicular → not on us
  });

  it("peer targets: a peer WITH broadcast aim on the bot passes the swarm's dodge gate; one with no aim (undefined) never does", () => {
    // mirrors the sim's gate exactly: `t.aimX !== undefined && beingAimedAt(bx, bz, t.x, t.z, t.aimX, t.aimZ ?? 0)`
    const aiming: AiTarget = { id: 2, x: 10, y: 1, z: 0, hp: 100, maxHp: 100, aimX: -1, aimZ: 0 };
    expect(aiming.aimX !== undefined && beingAimedAt(0, 0, aiming.x, aiming.z, aiming.aimX, aiming.aimZ ?? 0)).toBe(true);
    const legacy: AiTarget = { id: 3, x: 10, y: 1, z: 0, hp: 100, maxHp: 100 }; // never sent ax/az
    expect(legacy.aimX !== undefined && beingAimedAt(0, 0, legacy.x, legacy.z, legacy.aimX ?? 0, legacy.aimZ ?? 0)).toBe(false);
  });

  it("separation pushes away from a close neighbour and ignores far ones", () => {
    const [sx, sz] = separation(0, 0, [{ x: 2, z: 0 }], 3.2);
    expect(sx).toBeLessThan(0); expect(sz).toBeCloseTo(0, 6);        // neighbour at +x → pushed −x
    expect(separation(0, 0, [{ x: 10, z: 0 }], 3.2)).toEqual([0, 0]); // out of radius → no push
  });

  it("shouldBoom: only a kamikaze, and only once it's basically on the target", () => {
    expect(shouldBoom("kamikaze", 2, 1)).toBe(true);
    expect(shouldBoom("kamikaze", 5, 0)).toBe(false);  // too far on XZ
    expect(shouldBoom("gunner", 0, 0)).toBe(false);    // not a kamikaze
  });

  it("applyHeal tops up allies in range (clamped, no overheal)", () => {
    const allies = [{ x: 0, z: 0, hp: 1, maxHp: 3 }, { x: 20, z: 0, hp: 1, maxHp: 3 }];
    expect(applyHeal(0, 0, allies, 14, 1)).toBe(1);
    expect(allies[0].hp).toBe(2);  // in range → +1
    expect(allies[1].hp).toBe(1);  // out of range → unchanged
    expect(applyHeal(0, 0, [{ x: 0, z: 0, hp: 3, maxHp: 3 }], 14, 1)).toBe(0); // already full → no overheal
  });

  it("pickKind introduces the harder archetypes only as waves climb; roles are distinct", () => {
    expect(pickKind(() => 0.95, 0)).not.toBe("kamikaze"); // wave 0 → base trio only
    expect(pickKind(() => 0.95, 5)).toBe("kamikaze");
    expect(pickKind(() => 0.89, 5)).toBe("tank");
    expect(pickKind(() => 0.83, 5)).toBe("support");
    expect(ARCHETYPES.tank.hp).toBeGreaterThan(ARCHETYPES.gunner.hp);      // tank is tanky…
    expect(ARCHETYPES.tank.speed).toBeLessThan(ARCHETYPES.gunner.speed);   // …and slow
    expect(ARCHETYPES.kamikaze.speed).toBeGreaterThan(ARCHETYPES.chaser.speed); // kamikaze is the fastest
    expect(ARCHETYPES.support.hold).toBeGreaterThan(ARCHETYPES.gunner.hold);     // support hangs back
  });

  it("tick: a kamikaze that reaches its target DETONATES (emits a boom + is consumed)", () => {
    const s = new AiSwarm();
    for (let i = 0; i < 3; i++) s.spawnWave(0, 0, 0, 2, () => 0.95); // wave 2 → kamikazes, sitting on the origin
    expect(s.list.some((b) => b.kind === "kamikaze")).toBe(true);
    const booms: AiBoom[] = [];
    s.tick(0.05, [{ id: 9, x: 0, y: 0, z: 0 }], () => true, () => 0.5, undefined, booms);
    expect(booms.length).toBeGreaterThan(0);
    expect(booms[0].targetId).toBe(9);
    expect(s.list.some((b) => b.kind === "kamikaze")).toBe(false); // detonated on contact → removed
  });

  it("damageBot: a TANK shields its FRONT (frontal shot ~75% mitigated) but takes full damage from behind", () => {
    const s = new AiSwarm();
    for (let i = 0; i < 4; i++) s.spawnWave(0, 0, 0, 2, () => 0.89); // wave 3 → tanks
    s.tick(0.01, [{ id: 1, x: 100, y: 0, z: 0 }]); // one tick so they FACE the far +x target
    const tanks = s.list.filter((b) => b.kind === "tank");
    expect(tanks.length).toBeGreaterThan(1);
    const front = tanks[0], rear = tanks[1], hp0 = front.hp;
    s.damageBot(front.id, 4, -1, 0); // shot travelling −x = into its front → shielded
    s.damageBot(rear.id, 4, 1, 0);   // shot travelling +x = into its back → full
    expect(front.hp).toBeGreaterThan(rear.hp); // the shield saved the front tank
    expect(hp0 - front.hp).toBeLessThan(4);    // it took less than full damage
  });

  it("tick: a bot that has SEEN you hunts your LAST-SEEN spot when sight breaks (not a blind flank)", () => {
    const s = new AiSwarm();
    s.spawnWave(40, 0, 0, 5, () => 0); // a gunner at (40,·,0)
    s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => true); // sees the origin target → records last-seen (0,0)
    const x0 = s.list[0].x;
    s.tick(0.2, [{ id: 1, x: 0, y: 0, z: 60 }], () => false); // sight blocked + target teleports far to +z
    expect(s.list[0].x).toBeLessThan(x0); // still heads to the last-seen spot (−x), not toward the hidden target
  });

  it("tick: a hunter that lost sight CLIMBS to try to see over the cover", () => {
    const s = new AiSwarm();
    s.spawnWave(30, 0, 0, 5, () => 0);
    s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => true); // sees → memory set
    const y0 = s.list[0].y;
    for (let i = 0; i < 5; i++) s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => false); // now blind
    expect(s.list[0].y).toBeGreaterThan(y0); // rose to peek over the cover
  });

  it("FALSIFY: a huge multi-wave swarm (every archetype) stays finite, grounded, clamped and time-bounded", () => {
    const s = new AiSwarm();
    for (let w = 0; w < 6; w++) s.spawnWave(0, 0, 40, 14); // waves 0..5 → 100+ bots incl tank / kamikaze / support
    expect(s.count).toBeGreaterThan(120);
    const t0 = Date.now();
    let flip = false;
    for (let i = 0; i < 200; i++) {
      flip = !flip;
      const tx = Math.sin(i * 0.05) * 25;                  // a weaving, wounded, sometimes-firing target + a 2nd one
      const drops: AiDrop[] = [], booms: AiBoom[] = [];
      s.tick(0.05, [
        { id: 1, x: tx, y: 0, z: 0, vx: Math.cos(i * 0.05) * 5, vz: 0, hp: 60, maxHp: 150, firing: i % 3 === 0, aimX: -1, aimZ: 0 },
        { id: 2, x: 12, y: 0, z: 20, hp: 150, maxHp: 150 },
      ], () => flip, undefined, drops, booms); // LOS toggles each tick → drives memory / search / climb
    }
    const ms = Date.now() - t0;
    for (const b of s.list) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z)).toBe(true); // no NaN/Infinity
      expect(b.y).toBeGreaterThanOrEqual(2);          // never sinks into the ground
      expect(b.hp).toBeLessThanOrEqual(b.maxHp);      // support never overheals past maxHp
    }
    expect(ms).toBeLessThan(10000); // 200 ticks of a 100+ bot swarm stays bounded (O(n) spatial hash, not O(n²))
  });
});

describe("searchPoint — widening seed-sectored last-seen sweep (pure)", () => {
  const dist = (p: [number, number], ax: number, az: number) => Math.hypot(p[0] - ax, p[1] - az);
  it("radius GROWS with age (search farther the longer you're unseen), capped at maxR", () => {
    const r0 = dist(searchPoint(0, 0, 0.3, 0), 0, 0);
    const r5 = dist(searchPoint(0, 0, 0.3, 5), 0, 0);
    const rBig = dist(searchPoint(0, 0, 0.3, 1000), 0, 0);
    expect(r5).toBeGreaterThan(r0);              // older contact → wider ring
    expect(rBig).toBeLessThanOrEqual(22 + 1e-6); // capped at maxR
    expect(r0).toBeCloseTo(2);                   // starts near the anchor (base)
  });
  it("different seeds cover different SECTORS (fan out, not the same point)", () => {
    const a = searchPoint(0, 0, 0.1, 4), b = searchPoint(0, 0, 0.6, 4);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1); // distinct bearings → real spread
  });
  it("is centred on the last-seen anchor and stays finite", () => {
    const p = searchPoint(50, -30, 0.7, 3);
    expect(dist(p, 50, -30)).toBeLessThanOrEqual(22 + 1e-6); // within maxR of the anchor
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
    expect(dist(searchPoint(0, 0, 0.5, -5), 0, 0)).toBeCloseTo(2); // guards a negative age → base radius
  });
});

describe("enemy AI — perception (sight + hearing, belief that decays)", () => {
  it("beliefAccuracy decays from its update value, monotonically, never below the floor", () => {
    expect(beliefAccuracy(1, 0)).toBeCloseTo(1);                 // fresh sighting → exact
    expect(beliefAccuracy(1, 2)).toBeLessThan(beliefAccuracy(1, 0)); // fades with age
    expect(beliefAccuracy(1, 3)).toBeLessThanOrEqual(beliefAccuracy(1, 1));
    expect(beliefAccuracy(1, 1000)).toBeGreaterThanOrEqual(0.15); // SEMI: never fully lost
    expect(beliefAccuracy(0.6, 0)).toBeCloseTo(0.6);             // heard → approximate, never > its source
    expect(beliefAccuracy(1, -5)).toBeLessThanOrEqual(1);        // guards a negative age
  });

  it("beliefGoal is exact at accuracy 1 and drifts a BOUNDED, seed-distinct amount as it falls", () => {
    expect(beliefGoal(50, 20, 0.3, 0, 1)).toEqual([50, 20]);     // sure → the anchor itself
    const g = beliefGoal(50, 20, 0.3, 1.4, 0.2);
    const drift = Math.hypot(g[0] - 50, g[1] - 20);
    expect(drift).toBeGreaterThan(0);                            // unsure → wanders
    expect(drift).toBeLessThanOrEqual(6 + 1e-6);                 // but bounded by maxDrift
    // two different bots (seeds) drift in different directions → fan-out, not a single re-clump point
    const a = beliefGoal(50, 20, 0.1, 1.4, 0.2), b = beliefGoal(50, 20, 0.8, 1.4, 0.2);
    expect(a[0] !== b[0] || a[1] !== b[1]).toBe(true);
  });

  it("pickAudible hears the best-margin noise and ignores anything out of range", () => {
    const noises: AiNoise[] = [{ x: 100, z: 0, loud: 10 }, { x: 5, z: 0, loud: 12 }, { x: 0, z: 60, loud: 40 }];
    expect(pickAudible(0, 0, noises)).toBe(1);                   // the near footstep (margin 7) beats the far blast (margin −20+40=... )
    expect(pickAudible(0, 0, [{ x: 200, z: 0, loud: 10 }])).toBe(-1); // nothing audible
    expect(pickAudible(0, 0, [])).toBe(-1);
    // a loud explosion out-margins a near quiet step
    expect(pickAudible(0, 0, [{ x: 6, z: 0, loud: 8 }, { x: 20, z: 0, loud: 70 }])).toBe(1);
  });

  it("holdMult layers stand-off distances outward (seed 0 = base, higher = farther)", () => {
    expect(holdMult(0)).toBeCloseTo(1.0);      // seed 0 → neutral base range (keeps existing orbit behaviour)
    expect(holdMult(1)).toBeCloseTo(1.9);
    expect(holdMult(0.5)).toBeGreaterThan(holdMult(0));
    expect(holdMult(0.5)).toBeLessThan(holdMult(1));
    expect(holdMult(0.3)).toBeGreaterThanOrEqual(1.0); // never tighter than base → no crowding inward
  });

  it("shouldSuppress is gunner/tank only, needs a fresh belief and an off cooldown", () => {
    expect(shouldSuppress("gunner", true, 0)).toBe(true);
    expect(shouldSuppress("tank", true, -0.1)).toBe(true);
    expect(shouldSuppress("chaser", true, 0)).toBe(false);      // only the ranged suppressors
    expect(shouldSuppress("gunner", false, 0)).toBe(false);     // stale belief → no blind spray
    expect(shouldSuppress("tank", true, 0.5)).toBe(false);      // on cooldown
  });
});

describe("openingSeek — steer a blocked bot toward a door/window (pure)", () => {
  // a wall at x∈[4,5) spanning all z EXCEPT an open doorway at z∈[1,3]; bot in front at (3.5,0), goal +x
  const wall = (x: number, _y: number, z: number) => x >= 4 && x < 5 && !(z >= 1 && z < 3);
  it("finds the nearby opening and returns its XZ + a low entry height", () => {
    const ok = openingSeek(3.5, 0, 1, 0, wall);
    expect(ok).not.toBeNull();
    expect(ok![1]).toBeGreaterThan(0.5); expect(ok![1]).toBeLessThan(3.5); // steered toward the +z doorway
    expect([1.5, 4.5]).toContain(ok![2]);                                  // an entry height, not the bot's height
  });
  it("returns null when the wall is solid at every entry height (→ the bot climbs instead)", () => {
    expect(openingSeek(3.5, 0, 1, 0, (x) => x >= 4 && x < 5)).toBeNull(); // infinite wall, no gap
  });
  it("seed splits which side is scanned first → the swarm fans across two doorways", () => {
    const twoDoors = (x: number, _y: number, z: number) => x >= 4 && x < 5 && !((z >= 1 && z < 3) || (z > -3 && z <= -1));
    const a = openingSeek(3.5, 0, 1, 0, twoDoors, 0.1); // low seed → +z first
    const b = openingSeek(3.5, 0, 1, 0, twoDoors, 0.9); // high seed → −z first
    expect(Math.sign(a![1])).not.toBe(Math.sign(b![1]));
  });
});

describe("enemy AI — building entry (openingSeek + break requests)", () => {
  it("tick: a bot blocked between it and its last-seen target requests a break of the wall ahead", () => {
    const s = new AiSwarm();
    s.spawnWave(20, 0, 0, 5, () => 0.5);               // a CHASER at (20,·,0) (pushes IN, hold 5m), target at the origin
    const wall = (x: number) => x >= 8 && x <= 10;     // an unbroken wall between the bot and the target
    s.tick(0.05, [{ id: 1, x: 0, y: 0, z: 0 }], () => true, () => 0.5, undefined, undefined, (x) => wall(x)); // sees → belief (0,0)
    const breaks: AiBreak[] = [];
    for (let i = 0; i < 60; i++)
      s.tick(0.05, [{ id: 1, x: 0, y: 0, z: 0 }], () => false, () => 0.5, undefined, undefined, (x) => wall(x), [], breaks);
    expect(breaks.length).toBeGreaterThan(0);          // pressed the wall with no opening → asked the game to clear it
    expect(breaks.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y))).toBe(true);
  });

  it("blind near the belief: DROPS to the door band and enters through the opening — never climbs to the roof", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 0, 0, () => 0);                   // a cluster at the origin (low seed → not kamikaze), spawned LOW
    for (const b of s.list) { b.y = 12; b.lsx = 12; b.lsz = 1; b.lsT = 0; b.ba = 1; } // start HIGH; each PERCEIVED you at (12,1), now unseen (inside)
    // a wall slab at x∈[5,7] (ALL heights — can't be climbed cheaply) with a DOORWAY gap at z∈[-1,3]
    const solid = (x: number, _y: number, z: number) => { const fx = Math.floor(x); return fx >= 5 && fx <= 7 && !(z >= -1 && z <= 3); };
    const startMaxY = Math.max(...s.list.map((b) => b.y));
    for (let i = 0; i < 32; i++) s.tick(0.1, [{ id: 7, x: 12, y: 1, z: 1 }], () => false, () => 0.5, undefined, undefined, solid);
    const maxY = Math.max(...s.list.map((b) => b.y)), maxX = Math.max(...s.list.map((b) => b.x));
    expect(maxY).toBeLessThan(startMaxY - 4);          // DESCENDED to the entry band — did NOT climb toward the roof (+8)
    expect(maxY).toBeLessThan(8);                      // hovering at door/window height, not on top of the wall
    expect(maxX).toBeGreaterThan(6);                   // pressed THROUGH the doorway (into the x5-7 wall zone), not stuck outside
  });
});

describe("enemy AI — EMP stun (crowd control)", () => {
  it("stunBots disables bots in radius; a stunned bot does not move or fire", () => {
    const s = new AiSwarm();
    s.spawnWave(5, 0, 0, 5, () => 0.5); // chasers stacked at (5,·,0), target at origin (they'd rush −x)
    const before = { x: s.list[0].x, y: s.list[0].y };
    const n = s.stunBots(5, 0, 4, 2);                 // EMP within 4 m for 2 s → catches the whole cluster
    expect(n).toBe(s.count);                          // every bot in range disabled
    const fires = s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => true); // would normally approach + maybe fire
    expect(s.list[0].x).toBeCloseTo(before.x);        // frozen — no movement
    expect(s.list[0].y).toBeCloseTo(before.y);
    expect(fires.length).toBe(0);                     // disabled — no shots
    expect(s.list[0].stun).toBeGreaterThan(0);        // still stunned (2 − 0.1)
  });
  it("stun wears off and the bot resumes", () => {
    const s = new AiSwarm();
    s.spawnWave(20, 0, 0, 5, () => 0.5);              // FAR from the target → chasers APPROACH (move −x), not orbit
    s.stunBots(20, 0, 4, 0.1);                        // one-tick stun at dt 0.1
    s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => true); // still stunned this tick (0.1 → 0.0), frozen
    const xMid = s.list[0].x;
    s.tick(0.1, [{ id: 1, x: 0, y: 0, z: 0 }], () => true); // stun elapsed → moves again
    expect(s.list[0].x).toBeLessThan(xMid);           // resumed approaching the origin (−x)
    expect(s.stunBots(99, 99, 1, 1)).toBe(0);         // out of range → nobody stunned
  });
});

describe("enemy AI — grid collision (bots don't fly through walls)", () => {
  const tick = (s: AiSwarm, solid: (x: number, y: number, z: number) => boolean) =>
    s.tick(0.05, [{ id: 1, x: 0, y: 0, z: 0 }], () => true, () => 0.5, undefined, undefined, solid);

  it("does NOT tunnel through a solid wall — it stops at the wall and climbs to clear it", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0);           // bots at (60, ~y, 0); target at the origin (they push −x)
    const y0 = Math.max(...s.list.map((b) => b.y));
    const wall = (x: number) => x >= 28 && x <= 32; // an infinitely tall wall slab across their path
    for (let i = 0; i < 150; i++) tick(s, (x) => wall(x));
    for (const b of s.list) {
      expect(b.x).toBeGreaterThan(27);           // never crossed to the far side of the wall
      expect(Number.isFinite(b.x)).toBe(true);
    }
    expect(Math.max(...s.list.map((b) => b.y))).toBeGreaterThan(y0 + 3); // blocked → climbed
  });

  it("climbs OVER a finite wall and reaches the far side (toward the target)", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0);
    const wall = (x: number, y: number) => x >= 28 && x <= 32 && y < 12; // only up to y=12 → clearable
    let crossed = false;
    for (let i = 0; i < 400 && !crossed; i++) {
      tick(s, (x, y) => wall(x, y));
      if (s.list.some((b) => b.x < 26)) crossed = true;
    }
    expect(crossed).toBe(true);                  // rose above the wall and passed to the far side
  });

  it("a FAST late-wave bot cannot tunnel a THIN (one-voxel) wall — sub-voxel marching catches it", () => {
    const s = new AiSwarm();
    for (let w = 0; w < 8; w++) s.spawnWave(60, 0, 0, 1, () => 0); // waves 0..7 → high speedScale (fast bots)
    const thin = (x: number) => x >= 30 && x <= 30.25;             // a single-voxel-thick wall
    for (let i = 0; i < 200; i++) tick(s, (x) => thin(x));
    for (const b of s.list) expect(b.x).toBeGreaterThan(30);       // none slipped past the thin wall
  });

  it("with no solid predicate (default) movement is unchanged — a far bot still closes in", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0);
    const x0 = s.list[0].x;
    for (let i = 0; i < 40; i++) s.tick(0.05, [{ id: 1, x: 0, y: 0, z: 0 }], () => true, () => 0.5);
    expect(s.list[0].x).toBeLessThan(x0);        // approached the target, no collision no-op regression
  });
});

describe("enemy AI — difficulty tiers (single multiplier, normal = 1 = untiered)", () => {
  it("difficultyMul: easy < 1 < hard, normal is exactly 1, and an unknown value falls to normal", () => {
    expect(difficultyMul("easy")).toBeLessThan(1);
    expect(difficultyMul("hard")).toBeGreaterThan(1);
    expect(difficultyMul("normal")).toBe(1);
    expect(difficultyMul("bogus" as any)).toBe(1); // invalid ?diff= must map to normal
  });

  it("spawnWave: hard spawns more bots than easy (both ≥ 1) for identical args", () => {
    const hardS = new AiSwarm(), easyS = new AiSwarm();
    hardS.difficulty = difficultyMul("hard");
    easyS.difficulty = difficultyMul("easy");
    for (let w = 0; w < 3; w++) {
      const nh = hardS.spawnWave(0, 0, 30, 5, () => 0.5);
      const ne = easyS.spawnWave(0, 0, 30, 5, () => 0.5);
      expect(ne).toBeGreaterThanOrEqual(1);
      expect(nh).toBeGreaterThan(ne);
    }
  });

  it("fires at hard difficulty carry more damage than at easy (same sighted setup)", () => {
    const fireAt = (d: number): number => {
      const s = new AiSwarm();
      s.difficulty = d;
      s.spawnWave(20, 0, 0, 5, () => 0); // gunners in range, cd 0 — only acquisition gates the first shot
      let fires: AiFire[] = [];
      for (let i = 0; i < 8 && fires.length === 0; i++)
        fires = s.tick(0.1, [{ id: 7, x: 0, y: 1, z: 0 }], () => true, () => 0.5);
      expect(fires.length).toBeGreaterThan(0);
      return fires[0].dmg;
    };
    expect(fireAt(difficultyMul("hard"))).toBeGreaterThan(fireAt(difficultyMul("easy")));
  });

  it("DEFAULT IDENTITY: a swarm left at difficulty 1 spawns exactly waveSize(w) bots (normal is a no-op)", () => {
    const s = new AiSwarm();
    expect(s.difficulty).toBe(1);
    for (let w = 0; w < 3; w++) expect(s.spawnWave(0, 0, 30, 5, () => 0.5)).toBe(waveSize(w));
  });
});
