import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { RemoteDrones } from "../src/net/remoteDrones";
import type { Physics } from "../src/engine/physics";

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
