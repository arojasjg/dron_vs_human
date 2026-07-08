import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { DEBRIS_SLEEP_DESPAWN, MAX_DEBRIS, VOXEL } from "../config";
import { GROUP_DEBRIS, type Physics } from "../engine/physics";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "../world/materials";
import type { Rng } from "../engine/rng";

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const Q = new THREE.Quaternion();
const M = new THREE.Matrix4();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

interface MatPool {
  mesh: THREE.InstancedMesh;
  free: number[];
  capacity: number;
}

interface Debris {
  body: RAPIER.RigidBody;
  material: MaterialId;
  slot: number;
  sleep: number;
  age: number;
  half: number;
}

/** Hard cap on a debris cube's lifetime. Without it, a cube wedged in geometry never sleeps,
 *  so it never despawns and accumulates across a session — growing the physics cost and causing
 *  periodic idle hitches. */
const DEBRIS_MAX_AGE = 7;

export class DebrisSystem {
  private readonly pools = new Map<MaterialId, MatPool>();
  private readonly active: Debris[] = [];
  /** Max simultaneously active debris; lowered by the perf governor under load. */
  cap = MAX_DEBRIS;

  /** Called with a cube's resting transform when it settles, to leave persistent visual rubble. */
  onSettle?: (x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, material: MaterialId) => void;

  constructor(private readonly physics: Physics, scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const capacity = Math.ceil(MAX_DEBRIS / 2);
    for (const id of MATERIAL_ORDER) {
      const def = MATERIALS[id];
      const mat = new THREE.MeshStandardMaterial({
        color: def.color, roughness: def.roughness, metalness: def.metalness,
        transparent: def.opacity < 1, opacity: def.opacity,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = capacity;
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, HIDDEN);
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      const free: number[] = [];
      for (let i = capacity - 1; i >= 0; i--) free.push(i);
      this.pools.set(id, { mesh, free, capacity });
    }
  }

  get count(): number {
    return this.active.length;
  }

  /** Snapshot of each active chunk's world position and kinetic energy (½·m·v²) — fed to the
   *  interactive-impact resolver so fast/heavy chunks can hurt drones and set off gas tanks. */
  impacts(): { x: number; y: number; z: number; ke: number }[] {
    const out: { x: number; y: number; z: number; ke: number }[] = [];
    for (const d of this.active) {
      const v = d.body.linvel();
      const t = d.body.translation();
      const size = d.half * 2;
      const mass = MATERIALS[d.material].density * size * size * size;
      out.push({ x: t.x, y: t.y, z: t.z, ke: 0.5 * mass * (v.x * v.x + v.y * v.y + v.z * v.z) });
    }
    return out;
  }

  /** Canonical snapshot of every active chunk's material + world transform — for determinism hashing.
   *  Read-only sibling of impacts(); the caller sorts + rounds for a stable, order-free comparison. */
  snapshot(): { material: MaterialId; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }[] {
    const out: { material: MaterialId; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }[] = [];
    for (const d of this.active) {
      const t = d.body.translation();
      const r = d.body.rotation();
      out.push({ material: d.material, x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w });
    }
    return out;
  }

  /** Spawns one voxel-sized rigid cube of debris. Returns false if the pool is full. */
  spawn(
    cx: number, cy: number, cz: number,
    material: MaterialId,
    vx: number, vy: number, vz: number,
    half = VOXEL / 2,
    rng?: Rng,
  ): boolean {
    if (this.active.length >= this.cap) this.despawnOldest();
    const pool = this.pools.get(material)!;
    if (pool.free.length === 0) return false;

    const def = MATERIALS[material];
    const slot = pool.free.pop()!;

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(cx, cy, cz)
        .setLinvel(vx, vy, vz)
        .setAngvel(rng ? { x: rng.centered(8), y: rng.centered(8), z: rng.centered(8) } : { x: 0, y: 0, z: 0 })
        .setLinearDamping(0.05)
        .setAngularDamping(0.25),
    );
    body.userData = { area: (half * 2) * (half * 2), cd: 1.1, kind: "debris" };

    const cdesc = RAPIER.ColliderDesc.cuboid(half, half, half)
      .setDensity(def.density)
      .setFriction(def.friction)
      .setRestitution(def.restitution)
      .setCollisionGroups(GROUP_DEBRIS);
    this.physics.world.createCollider(cdesc, body);

    this.active.push({ body, material, slot, sleep: 0, age: 0, half });
    return true;
  }

  private despawnOldest(): void {
    const d = this.active.shift();
    if (d) this.release(d);
  }

  private release(d: Debris): void {
    this.physics.world.removeRigidBody(d.body);
    const pool = this.pools.get(d.material)!;
    pool.mesh.setMatrixAt(d.slot, HIDDEN);
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.free.push(d.slot);
  }

  update(dt: number): void {
    const dirty = new Set<MatPool>();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const d = this.active[i];
      d.age += dt;
      const sleeping = d.body.isSleeping();
      if (sleeping) d.sleep += dt; else d.sleep = 0;
      if ((sleeping && d.sleep > DEBRIS_SLEEP_DESPAWN) || d.age > DEBRIS_MAX_AGE) {
        // leave a permanent visual rubble piece where it came to rest (only when actually settled,
        // so nothing is stamped mid-air)
        if (this.onSettle && sleeping) {
          const t = d.body.translation(), r = d.body.rotation();
          this.onSettle(t.x, t.y, t.z, r.x, r.y, r.z, r.w, d.material);
        }
        this.release(d);
        this.active.splice(i, 1);
        continue;
      }
      const t = d.body.translation();
      const r = d.body.rotation();
      P.set(t.x, t.y, t.z);
      Q.set(r.x, r.y, r.z, r.w);
      S.setScalar(d.half * 2);
      M.compose(P, Q, S);
      const pool = this.pools.get(d.material)!;
      pool.mesh.setMatrixAt(d.slot, M);
      dirty.add(pool);
    }
    for (const pool of dirty) pool.mesh.instanceMatrix.needsUpdate = true;
  }
}
