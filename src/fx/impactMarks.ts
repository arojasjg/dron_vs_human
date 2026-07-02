import * as THREE from "three";
import { VOXEL } from "../config";

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);
const P = new THREE.Vector3();
const N = new THREE.Vector3();
const Q = new THREE.Quaternion();
const ROLL = new THREE.Quaternion();
const S = new THREE.Vector3();
const M = new THREE.Matrix4();

/** Procedural crack/scorch sprite — no external assets. */
function makeCrackTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.translate(32, 32);
  ctx.strokeStyle = "rgba(20,18,16,0.85)";
  ctx.lineWidth = 2;
  const spokes = 7;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + Math.random() * 0.4;
    const r = 14 + Math.random() * 12;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let s = 1; s <= 3; s++) {
      const rr = (r * s) / 3;
      const aa = a + (Math.random() - 0.5) * 0.5;
      ctx.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(10,8,6,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(c);
}

/**
 * Accumulating bullet impact marks (decals) drawn as camera-independent quads laid flat on
 * the hit face. Marks are tracked per voxel so they can be cleared when that voxel breaks,
 * and recycled oldest-first once the pool is full.
 */
export class ImpactMarks {
  private readonly mesh: THREE.InstancedMesh;
  private readonly free: number[] = [];
  private readonly order: number[] = [];
  private readonly byVoxel = new Map<number, number[]>();
  private readonly slotVoxel = new Map<number, number>();

  constructor(scene: THREE.Scene, capacity = 240) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: makeCrackTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    for (let i = capacity - 1; i >= 0; i--) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.free.push(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** Adds one mark on the hit face of `voxelKey`. */
  add(voxelKey: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
    let slot = this.free.pop();
    if (slot === undefined) slot = this.recycleOldest();

    N.set(nx, ny, nz);
    if (N.lengthSq() < 1e-6) N.set(0, 1, 0); else N.normalize();
    P.set(px + N.x * 0.012, py + N.y * 0.012, pz + N.z * 0.012);
    Q.setFromUnitVectors(PLANE_NORMAL, N);
    ROLL.setFromAxisAngle(N, Math.random() * Math.PI * 2);
    Q.premultiply(ROLL);
    const s = VOXEL * (0.5 + Math.random() * 0.25);
    S.set(s, s, s);
    M.compose(P, Q, S);
    this.mesh.setMatrixAt(slot, M);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.order.push(slot);
    this.slotVoxel.set(slot, voxelKey);
    let arr = this.byVoxel.get(voxelKey);
    if (!arr) { arr = []; this.byVoxel.set(voxelKey, arr); }
    arr.push(slot);
  }

  /** Removes every mark belonging to a voxel (call when it is destroyed). */
  clearVoxel(voxelKey: number): void {
    const arr = this.byVoxel.get(voxelKey);
    if (!arr) return;
    for (const slot of arr.slice()) {
      this.detach(slot);
      this.free.push(slot);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private recycleOldest(): number {
    const slot = this.order[0];
    this.detach(slot);
    return slot;
  }

  /** Hides a slot and drops it from all registries, WITHOUT returning it to the free list. */
  private detach(slot: number): void {
    const vk = this.slotVoxel.get(slot);
    if (vk !== undefined) {
      const arr = this.byVoxel.get(vk);
      if (arr) {
        const i = arr.indexOf(slot);
        if (i >= 0) arr.splice(i, 1);
        if (arr.length === 0) this.byVoxel.delete(vk);
      }
      this.slotVoxel.delete(slot);
    }
    const oi = this.order.indexOf(slot);
    if (oi >= 0) this.order.splice(oi, 1);
    this.mesh.setMatrixAt(slot, HIDDEN);
  }
}
