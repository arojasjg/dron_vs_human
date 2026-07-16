import * as THREE from "three";
import { VOXEL } from "../config";
import type { AmmoSite } from "../build/prefabs";
import { loadInstancedModel, type InstancedPart } from "../engine/instancedModel";

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
  private meshes: THREE.InstancedMesh[] = [];   // one InstancedMesh per material part (glTF) or one box (fallback)
  private readonly geo = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly dummy = new THREE.Object3D();
  private dirty = false;
  private parts: InstancedPart[] | null = null; // downloaded glTF parts once ready (null = box fallback)
  private baseY = CRATE_SIZE / 2;               // instance Y for a live pickup (box: half-height; glTF: 0, base on ground)

  /** `color` tints the fallback box (default olive ammo box; pass a red for medkits). `modelUrl` (optional)
   *  streams a CC0 glTF prop that REPLACES the box once loaded — kept as ONE InstancedMesh per material so a
   *  field of pickups still costs a fixed few draw calls. `modelH` fits the model to that height in metres. */
  constructor(private readonly scene: THREE.Scene, color = 0x5a6b2e, emissive = 0x39461a,
              modelUrl?: string, modelH = 0.6) {
    this.mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2, emissive, emissiveIntensity: 0.55 });
    if (modelUrl) void loadInstancedModel(modelUrl, modelH).then((p) => {
      if (!p) return;
      // the glTF ships with flat, unlit-looking materials → give each part a self-glow (its own colour/texture)
      // so a medkit/ammo box POPS on a dim street and reads as "pickup", like the old emissive crate did.
      for (const part of p) {
        const m = part.material as THREE.MeshStandardMaterial;
        if (!m.isMeshStandardMaterial) continue;
        m.emissive.copy(m.color);
        if (m.map) m.emissiveMap = m.map;   // textured (ammo crate) → the texture itself glows
        m.emissiveIntensity = 0.55;
      }
      this.parts = p; this.baseY = 0;
      if (this.crates.length) this.rebuildMeshes();
    });
  }

  /** (Re)builds the crate set from placement sites — all live. Empty list clears the crates. */
  build(sites: readonly AmmoSite[]): void {
    this.crates = sites.map((s) => ({ x: (s.vx + 0.5) * VOXEL, z: (s.vz + 0.5) * VOXEL, live: true, respawnAt: 0 }));
    this.rebuildMeshes();
  }

  /** Rebuilds the InstancedMesh(es) for the current crate count — glTF parts if downloaded, else the box. */
  private rebuildMeshes(): void {
    for (const m of this.meshes) { this.scene.remove(m); m.dispose(); }
    this.meshes = [];
    if (this.crates.length === 0) return;
    const specs = this.parts ?? [{ geometry: this.geo, material: this.mat }];
    for (const p of specs) {
      const m = new THREE.InstancedMesh(p.geometry, p.material, this.crates.length);
      m.castShadow = true;
      this.meshes.push(m);
      this.scene.add(m);
    }
    this.writeMatrices();
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
    if (this.meshes.length === 0) return;
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.live) {
        this.dummy.position.set(c.x, this.baseY, c.z);
        this.dummy.scale.setScalar(1);
      } else {
        this.dummy.position.set(c.x, -100, c.z); // zero-scaled + buried → invisible while taken
        this.dummy.scale.setScalar(0);
      }
      this.dummy.updateMatrix();
      for (const m of this.meshes) m.setMatrixAt(i, this.dummy.matrix); // every material part shares the crate's transform
    }
    for (const m of this.meshes) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
  }
}
