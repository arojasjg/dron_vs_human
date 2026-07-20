import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { RemoteDrones, facingYawFromVelocity } from "../src/net/remoteDrones";
import type { Physics } from "../src/engine/physics";

// a HUMAN upsert kicks off the soldier glTF load; node has no asset server → stub the loader (null = "load
// failed", the production fallback path) so the aim tests run clean without touching the network/loader.
vi.mock("../src/engine/modelLoader", () => ({
  instanceModel: () => Promise.resolve(null),
  pickAction: () => null,
}));

// The avatar collider needs a physics world; interpolation doesn't — a tiny stub keeps this test Rapier-free.
const fakePhysics = () => ({
  world: {
    createRigidBody: () => ({ setNextKinematicTranslation() {} }),
    createCollider: () => ({}),
    removeRigidBody() {},
  },
}) as unknown as Physics;
const makeRemotes = () => new RemoteDrones(new THREE.Scene(), fakePhysics());

describe("remote peer interpolation (smooth multiplayer)", () => {
  it("eases a remote toward its last received position instead of snapping each packet", () => {
    const r = makeRemotes();
    r.upsert(1, 0, 0, 0, 0, 0, 0, 1, 100);     // first packet → appears at the origin
    r.upsert(1, 2, 0, 0, 0, 0, 0, 1, 100);     // a normal 2 m step (position must NOT jump there)
    expect(r.firstPos()!.x).toBeLessThan(0.2); // still near the old position — not snapped
    r.update(1 / 60);
    const after1 = r.firstPos()!.x;
    expect(after1).toBeGreaterThan(0);         // moved toward the target…
    expect(after1).toBeLessThan(2);            // …but only part-way (interpolating, no jump)
    for (let i = 0; i < 40; i++) r.update(1 / 60);
    expect(r.firstPos()!.x).toBeGreaterThan(1.9); // converges to the target over a few frames
  });

  it("snaps a big jump (respawn/teleport) instead of sliding the avatar across the map", () => {
    const r = makeRemotes();
    r.upsert(4, 0, 0, 0, 0, 0, 0, 1, 100);     // at the origin
    r.upsert(4, 30, 0, 0, 0, 0, 0, 1, 100);    // teleport 30 m away (a respawn)
    r.update(1 / 60);
    expect(r.firstPos()!.x).toBeGreaterThan(29); // snapped over, not mid-slide across the map
  });

  it("snaps a NEWLY seen peer straight to its position (no slide-in from the origin)", () => {
    const r = makeRemotes();
    r.upsert(2, 20, 5, -3, 0, 0, 0, 1, 100);   // first sighting must appear AT its position
    expect(r.firstPos()!.x).toBeGreaterThan(19);
  });

  it("keeps an idle peer for 8 s (survives a backgrounded-tab gap) but drops a real disconnect", () => {
    const r = makeRemotes();
    const t0 = performance.now();
    r.upsert(3, 0, 0, 0, 0, 0, 0, 1, 100);     // lastSeen ≈ t0
    r.prune(t0 + 5000); expect(r.count).toBe(1); // 5 s gap → still shown (the heartbeat window)
    r.prune(t0 + 9000); expect(r.count).toBe(0); // 9 s silent → pruned (genuine disconnect)
  });
});

describe("facingYawFromVelocity (RND-A2: AI bots face where they fly)", () => {
  const P = Math.PI;
  it("faces +Z for forward (0,1) → yaw 0", () => { expect(facingYawFromVelocity(0, 1)).toBeCloseTo(0, 6); });
  it("faces +X for right (1,0) → yaw π/2", () => { expect(facingYawFromVelocity(1, 0)).toBeCloseTo(P / 2, 6); });
  it("faces −Z for back (0,-1) → yaw ±π", () => { expect(Math.abs(facingYawFromVelocity(0, -1))).toBeCloseTo(P, 6); });
  it("faces −X for left (-1,0) → yaw −π/2", () => { expect(facingYawFromVelocity(-1, 0)).toBeCloseTo(-P / 2, 6); });
  it("is finite (no NaN) at zero velocity (atan2(0,0)=0)", () => { expect(facingYawFromVelocity(0, 0)).toBe(0); });
});

describe("peer aim → AI targets (co-op dodge parity, CBT-H6)", () => {
  type Tgt = { id: number; x: number; y: number; z: number; hp: number; maxHp: number; aimX?: number; aimZ?: number };

  it("carries a human peer's broadcast aim through humanTargets", () => {
    const r = makeRemotes();
    r.upsert(7, 1, 2, 3, 0, 0, 0, 1, 100, "human", 100, 0, 0, 0, 0, "", -0.8, 0.6);
    const out: Tgt[] = [];
    r.humanTargets(out);
    expect(out).toHaveLength(1);
    expect(out[0].aimX).toBe(-0.8);
    expect(out[0].aimZ).toBe(0.6);
  });

  it("keeps a peer that never sent aim as NOT aiming (aimX undefined, not 0) so the dodge gate stays off", () => {
    const r = makeRemotes();
    r.upsert(8, 0, 0, 0, 0, 0, 0, 1, 100, "human"); // legacy packet: no ax/az
    const out: Tgt[] = [];
    r.humanTargets(out);
    expect(out).toHaveLength(1);
    expect(out[0].aimX).toBeUndefined();
    expect(out[0].aimZ).toBeUndefined();
  });

  it("clears stale aim when a later packet omits it (pooled target objects must not leak old aim)", () => {
    const r = makeRemotes();
    r.upsert(9, 0, 0, 0, 0, 0, 0, 1, 100, "human", 100, 0, 0, 0, 0, "", 1, 0);
    const out: Tgt[] = [];
    r.humanTargets(out);
    expect(out[0].aimX).toBe(1);
    r.upsert(9, 0, 0, 0, 0, 0, 0, 1, 100, "human"); // older peer / omitted aim → back to undefined
    r.humanTargets(out);
    expect(out[0].aimX).toBeUndefined();
    expect(out[0].aimZ).toBeUndefined();
  });
});
