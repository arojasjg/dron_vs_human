import * as THREE from "three";
import { VOXEL } from "../config";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "../world/materials";

const _M = new THREE.Matrix4();
const _P = new THREE.Vector3();
const _Q = new THREE.Quaternion();
const _S = new THREE.Vector3(1, 1, 1);

interface Pool { mesh: THREE.InstancedMesh; next: number; used: number; cap: number; }

/**
 * Persistent, physics-free rubble. When a settled debris cube despawns (handing its body back to
 * the pool) we stamp its resting transform here, so the ground keeps a permanent debris field at
 * near-zero cost: one instanced draw per material, ring-buffered so it never grows unbounded.
 */
export class RubbleField {
  private readonly pools = new Map<MaterialId, Pool>();

  constructor(scene: THREE.Scene, capPerMaterial = 600) {
    const geo = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const id of MATERIAL_ORDER) {
      const def = MATERIALS[id];
      const mat = new THREE.MeshStandardMaterial({
        color: def.color, roughness: Math.min(1, def.roughness + 0.08), metalness: def.metalness,
        transparent: def.opacity < 1, opacity: def.opacity,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, capPerMaterial);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false; // ground rubble doesn't need to cast — saves shadow-map cost
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      for (let i = 0; i < capPerMaterial; i++) mesh.setMatrixAt(i, hidden);
      scene.add(mesh);
      this.pools.set(id, { mesh, next: 0, used: 0, cap: capPerMaterial });
    }
  }

  /** Leaves a permanent rubble instance at a settled piece's resting transform. */
  deposit(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, material: MaterialId): void {
    const pool = this.pools.get(material);
    if (!pool) return;
    _P.set(x, y, z);
    _Q.set(qx, qy, qz, qw);
    _M.compose(_P, _Q, _S);
    pool.mesh.setMatrixAt(pool.next, _M);
    pool.next = (pool.next + 1) % pool.cap;
    pool.used = Math.min(pool.used + 1, pool.cap);
    pool.mesh.count = pool.used;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }
}
