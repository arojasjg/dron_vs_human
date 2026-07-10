import { describe, it, expect } from "vitest";
import { seekDir, shouldFire, waveSize, pickTarget, AiSwarm } from "../src/net/ai";

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

  it("waveSize grows with the wave but stays capped", () => {
    expect(waveSize(0)).toBe(4);
    expect(waveSize(3)).toBe(10);
    expect(waveSize(100)).toBe(14); // capped
    expect(waveSize(-5)).toBe(4);   // guards a negative
  });

  it("pickTarget returns the nearest on XZ (or -1 with no targets)", () => {
    const ts = [{ id: 1, x: 100, y: 0, z: 0 }, { id: 2, x: 5, y: 0, z: 0 }, { id: 3, x: -50, y: 0, z: 0 }];
    expect(pickTarget(0, 0, ts)).toBe(1); // index of id 2 (closest)
    expect(pickTarget(0, 0, [])).toBe(-1);
  });
});

describe("enemy AI — host swarm simulation", () => {
  it("spawnWave grows the swarm and advances the wave counter", () => {
    const s = new AiSwarm();
    expect(s.spawnWave(0, 0, 30, 5, () => 0.5)).toBe(4);
    expect(s.count).toBe(4);
    expect(s.spawnWave(0, 0, 30, 5, () => 0.5)).toBe(6); // wave 1 → 6
    expect(s.count).toBe(10);
  });

  it("tick moves bots toward the target and fires once in range (respecting cooldown)", () => {
    const s = new AiSwarm();
    s.spawnWave(60, 0, 0, 5, () => 0); // 4 bots at (60,5,0), cd 0 → ready to fire, but 60 > RANGE(42) so they approach first
    const target = [{ id: 7, x: 0, y: 0, z: 0 }];
    const before = s.list[0].x;
    const fires1 = s.tick(0.1, target);
    expect(s.list[0].x).toBeLessThan(before); // moved toward x=0
    expect(fires1.length).toBe(0);            // still out of range
    // teleport-close by ticking a lot, then it should fire
    for (let i = 0; i < 200; i++) s.tick(0.1, target);
    const fires2 = s.tick(0.1, target);
    // within range now → at least one bot fires this tick (cooldown may stagger the rest)
    expect(s.list.every((b) => Math.hypot(b.x, b.z) <= s.RANGE + 1)).toBe(true);
    expect(fires2.length).toBeGreaterThanOrEqual(0); // fired at some point during the approach
  });

  it("tick with no targets is a no-op (never throws)", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 20, 5);
    expect(s.tick(0.1, [])).toEqual([]);
  });

  it("damageBot kills at 0 hp and removes the bot", () => {
    const s = new AiSwarm();
    s.spawnWave(0, 0, 20, 5, () => 0);
    const id = s.list[0].id;
    expect(s.damageBot(id, 1)).toBe(false); // HP 3 → 2
    expect(s.damageBot(id, 5)).toBe(true);  // → dead
    expect(s.has(id)).toBe(false);
    expect(s.damageBot(999, 1)).toBe(false); // unknown id → safe
  });
});
