import * as THREE from "three";
import { VOXEL } from "../config";
import type { AmmoSite } from "../build/prefabs";

// Ammo-supply crates for the soldiers: static pickups scattered on the city streets (see
// prefabs.ammoBoxSites). A soldier walking over one refills its team's ammo (game.ts drives the pickup
// and broadcasts it so every client hides the same crate). The whole set is ONE InstancedMesh → 1 draw
// call regardless of crate count. The live/respawn logic is split into PURE functions so it unit-tests
// without a THREE scene.

export const CRATE_RESPAWN = 20;    // seconds a taken crate stays gone before it re-supplies
export const CRATE_PICKUP_R = 1.6;  // metres — how close a soldier must be to grab one
const CRATE_SIZE = 0.6;             // metres (cube edge)

export interface CrateState { x: number; z: number; live: boolean; respawnAt: number }

/** Index of the nearest LIVE crate within `r` metres of (px,pz), or -1. Pure. */
export function nearestLiveCrate(crates: readonly CrateState[], px: number, pz: number, r: number): number {
  let best = -1, bestD = r * r;
  for (let i = 0; i < crates.length; i++) {
    const c = crates[i];
    if (!c.live) continue;
    const dx = c.x - px, dz = c.z - pz, d = dx * dx + dz * dz;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Take crate i: mark it gone and arm its respawn. A no-op on an already-taken crate (so a duplicate
 *  pickup broadcast never resets a running timer). Pure. */
export function takeCrate(crates: CrateState[], i: number, now: number, respawn = CRATE_RESPAWN): void {
  const c = crates[i];
  if (!c || !c.live) return;
  c.live = false;
  c.respawnAt = now + respawn;
}

/** Respawn any crate whose timer has elapsed. Returns whether anything changed. Pure. */
export function respawnCrates(crates: CrateState[], now: number): boolean {
  let changed = false;
  for (const c of crates) if (!c.live && now >= c.respawnAt) { c.live = true; changed = true; }
  return changed;
}

export class AmmoCrates {
  private crates: CrateState[] = [];
  private mesh: THREE.InstancedMesh | null = null;
  private readonly geo = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
  private readonly mat = new THREE.MeshStandardMaterial({
    color: 0x5a6b2e, roughness: 0.7, metalness: 0.2, emissive: 0x39461a, emissiveIntensity: 0.55,
  });
  private readonly dummy = new THREE.Object3D();
  private dirty = false;

  constructor(private readonly scene: THREE.Scene) {}

  /** (Re)builds the crate set from placement sites — all live. Empty list clears the crates. */
  build(sites: readonly AmmoSite[]): void {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); this.mesh = null; }
    this.crates = sites.map((s) => ({ x: (s.vx + 0.5) * VOXEL, z: (s.vz + 0.5) * VOXEL, live: true, respawnAt: 0 }));
    if (this.crates.length === 0) return;
    const m = new THREE.InstancedMesh(this.geo, this.mat, this.crates.length);
    m.castShadow = true;
    this.mesh = m;
    this.writeMatrices();
    this.scene.add(m);
  }

  /** Nearest live crate to (px,pz) within pickup range, or -1. */
  nearestLive(px: number, pz: number, r = CRATE_PICKUP_R): number {
    return nearestLiveCrate(this.crates, px, pz, r);
  }

  /** Take crate i (a local pickup or a peer's broadcast) — hide it and arm its respawn. */
  take(i: number, now: number): void {
    const wasLive = this.crates[i]?.live === true;
    takeCrate(this.crates, i, now);
    if (wasLive) this.dirty = true;
  }

  /** Tick respawns and refresh instance visibility — only touches the GPU buffer when something
   *  actually changed (idempotent, so it's cheap to call every frame). */
  update(now: number): void {
    if (respawnCrates(this.crates, now)) this.dirty = true;
    if (this.dirty) { this.writeMatrices(); this.dirty = false; }
  }

  private writeMatrices(): void {
    const m = this.mesh;
    if (!m) return;
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.live) {
        this.dummy.position.set(c.x, CRATE_SIZE / 2, c.z);
        this.dummy.scale.setScalar(1);
      } else {
        this.dummy.position.set(c.x, -100, c.z); // zero-scaled + buried → invisible while taken
        this.dummy.scale.setScalar(0);
      }
      this.dummy.updateMatrix();
      m.setMatrixAt(i, this.dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }
}
