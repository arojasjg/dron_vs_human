import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { Physics } from "../engine/physics";
import type { RayHit, VoxelGrid } from "../world/voxelGrid";

type Kind = "cannon" | "grenade" | "rocket" | "bullet";

const BULLET_AXIS = new THREE.Vector3(0, 1, 0);
const TMP = new THREE.Vector3();

interface Flying {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Object3D;
  kind: Kind;
  fuse: number;
  life: number;
  armed: number; // muzzle-safety delay before impact detonation is enabled (seconds)
  radius: number;
  power: number;
  prev: THREE.Vector3;
  stuck?: boolean; // grenades stick where they first hit, then count down
  ghost?: boolean; // a replayed remote shot: flies for visuals only, never mutates the grid
}

export type ExplodeFn = (x: number, y: number, z: number, radius: number, power: number) => void;
export type BulletHitFn = (hit: RayHit, dx: number, dy: number, dz: number) => void;

export class Projectiles {
  private readonly list: Flying[] = [];
  private readonly cannonGeo = new THREE.SphereGeometry(0.18, 16, 12);
  private readonly grenadeGeo = new THREE.SphereGeometry(0.13, 14, 10);
  private readonly cannonMat = new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.4, metalness: 0.9 });
  private readonly grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3f5a2a, roughness: 0.6, metalness: 0.3 });
  // missile parts (assembled along +Y in makeRocketMesh, then aimed along its velocity)
  private readonly rocketBodyGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.42, 10);
  private readonly rocketNoseGeo = new THREE.ConeGeometry(0.07, 0.16, 10);
  private readonly rocketFinGeo = new THREE.BoxGeometry(0.012, 0.12, 0.1);
  private readonly rocketExhaustGeo = new THREE.ConeGeometry(0.05, 0.12, 8);
  private readonly rocketBodyMat = new THREE.MeshStandardMaterial({ color: 0x9a9a90, roughness: 0.5, metalness: 0.6 });
  private readonly rocketNoseMat = new THREE.MeshStandardMaterial({ color: 0xcc2a1a, roughness: 0.4, metalness: 0.5 });
  private readonly rocketFinMat = new THREE.MeshStandardMaterial({ color: 0x3a3e38, roughness: 0.7, metalness: 0.4 });
  private readonly rocketExhaustMat = new THREE.MeshBasicMaterial({ color: 0xffc24d });
  // a thin, bright tracer stretched along its travel direction so the shot reads as a bullet
  private readonly bulletGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6);
  private readonly bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
    private readonly grid: VoxelGrid,
    private readonly explode: ExplodeFn,
    private readonly onBulletHit: BulletHitFn,
  ) {}

  /** Live missiles in flight (for tests/diagnostics). */
  get rocketCount(): number {
    let n = 0;
    for (const f of this.list) if (f.kind === "rocket") n++;
    return n;
  }

  launchCannonball(origin: THREE.Vector3, dir: THREE.Vector3, speed = 60, ghost = false, powerMul = 1): void {
    const m = new THREE.Mesh(this.cannonGeo, this.cannonMat);
    m.castShadow = true;
    this.spawn("cannon", origin, dir, speed, m, {
      radius: 0.18, ccd: true, density: 7800, restitution: 0, fuse: 0, blast: 2.6, power: 700 * powerMul,
    }, ghost);
  }

  launchGrenade(origin: THREE.Vector3, dir: THREE.Vector3, speed = 22, ghost = false, powerMul = 1): void {
    const m = new THREE.Mesh(this.grenadeGeo, this.grenadeMat);
    m.castShadow = true;
    this.spawn("grenade", origin, dir, speed, m, {
      radius: 0.13, ccd: true, density: 1200, restitution: 0.0, fuse: 1.6, blast: 2.4, power: 360 * powerMul,
    }, ghost);
  }

  launchRocket(origin: THREE.Vector3, dir: THREE.Vector3, speed = 52, ghost = false, powerMul = 1): void {
    this.spawn("rocket", origin, dir, speed, this.makeRocketMesh(), {
      radius: 0.17, ccd: true, density: 1500, restitution: 0, fuse: 0, blast: 3.4, power: 520 * powerMul, gravityScale: 0.1,
    }, ghost);
  }

  /** Builds a small missile (body + red nose + tail fins + a glowing exhaust), pointing along +Y
   *  so it can be aimed with the same up-axis the tracer uses. */
  private makeRocketMesh(): THREE.Object3D {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.rocketBodyGeo, this.rocketBodyMat);
    const nose = new THREE.Mesh(this.rocketNoseGeo, this.rocketNoseMat);
    nose.position.y = 0.29;
    const exhaust = new THREE.Mesh(this.rocketExhaustGeo, this.rocketExhaustMat);
    exhaust.position.y = -0.27;
    exhaust.rotation.x = Math.PI; // flame tapers backward (-Y)
    body.castShadow = true;
    nose.castShadow = true;
    g.add(body, nose, exhaust);
    for (let k = 0; k < 3; k++) {
      const fin = new THREE.Mesh(this.rocketFinGeo, this.rocketFinMat);
      const a = (k / 3) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 0.06, -0.17, Math.sin(a) * 0.06);
      fin.rotation.y = -a;
      fin.castShadow = true;
      g.add(fin);
    }
    return g;
  }

  /** A fast physical bullet. Impact is detected by raycasting the segment it travelled this
   *  frame (so it never tunnels), then handed to onBulletHit for concentrated damage. */
  launchBullet(origin: THREE.Vector3, dir: THREE.Vector3, speed = 120, ghost = false): void {
    const p = origin.clone().addScaledVector(dir, 0.5);
    const v = dir.clone().multiplyScalar(speed);
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel(v.x, v.y, v.z)
        .setCcdEnabled(true),
    );
    body.setGravityScale(0.05, false);
    body.userData = { area: 0.001, cd: 0.2, kind: "bullet" };
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.ball(0.03).setDensity(8000).setFriction(0.2).setRestitution(0),
      body,
    );
    const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
    mesh.quaternion.setFromUnitVectors(BULLET_AXIS, dir);
    mesh.position.copy(p);
    this.scene.add(mesh);
    this.list.push({ body, collider, mesh, kind: "bullet", fuse: 0, life: 1.5, armed: 0, radius: 0, power: 0, prev: p.clone(), ghost });
  }

  private spawn(
    kind: Kind, origin: THREE.Vector3, dir: THREE.Vector3, speed: number,
    visual: THREE.Object3D,
    o: { radius: number; ccd: boolean; density: number; restitution: number; fuse: number; blast: number; power: number; gravityScale?: number },
    ghost = false,
  ): void {
    const p = origin.clone().addScaledVector(dir, 0.6);
    const v = dir.clone().multiplyScalar(speed);
    let desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setLinvel(v.x, v.y, v.z)
      .setAngularDamping(0.1);
    if (o.ccd) desc = desc.setCcdEnabled(true);
    const body = this.physics.world.createRigidBody(desc);
    if (o.gravityScale !== undefined) body.setGravityScale(o.gravityScale, false);
    body.userData = { area: Math.PI * o.radius * o.radius, cd: 0.5, kind };
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.ball(o.radius).setDensity(o.density).setRestitution(o.restitution).setFriction(0.6),
      body,
    );

    visual.position.copy(p);
    this.scene.add(visual);

    this.list.push({
      body, collider, mesh: visual, kind, fuse: o.fuse, life: 6, armed: 0.04, radius: o.blast, power: o.power, prev: p.clone(), ghost,
    });
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      if (!f) continue; // a chain detonation this frame may have spliced entries out from under us
      const t = f.body.translation();
      const cur = new THREE.Vector3(t.x, t.y, t.z);
      f.mesh.position.copy(cur);
      f.life -= dt;
      f.armed -= dt;

      if (f.kind === "bullet") {
        const seg = new THREE.Vector3().subVectors(cur, f.prev);
        const len = seg.length();
        let consumed = false;
        if (len > 1e-4) {
          const hit = this.grid.raycast(f.prev.x, f.prev.y, f.prev.z, seg.x, seg.y, seg.z, len + 0.06);
          if (hit) {
            if (!f.ghost) { const inv = 1 / len; this.onBulletHit(hit, seg.x * inv, seg.y * inv, seg.z * inv); }
            consumed = true;
          } else {
            f.mesh.quaternion.setFromUnitVectors(BULLET_AXIS, TMP.copy(seg).multiplyScalar(1 / len));
          }
        }
        f.prev.copy(cur);
        if (consumed || f.life <= 0) {
          this.physics.world.removeRigidBody(f.body);
          this.scene.remove(f.mesh);
          this.list.splice(i, 1);
        }
        continue;
      }

      // a missile flies nose-first along its velocity; the cannonball just tumbles with physics
      if (f.kind === "rocket") {
        const lv = f.body.linvel();
        const sp = Math.hypot(lv.x, lv.y, lv.z);
        if (sp > 0.1) f.mesh.quaternion.setFromUnitVectors(BULLET_AXIS, TMP.set(lv.x / sp, lv.y / sp, lv.z / sp));
      } else {
        const r = f.body.rotation();
        f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }

      let detonate = false;
      let hx = cur.x, hy = cur.y, hz = cur.z;

      if (f.kind === "cannon" || f.kind === "rocket") {
        // detonate on impact with anything in this frame's travel path
        const seg = new THREE.Vector3().subVectors(cur, f.prev);
        const len = seg.length();
        if (len > 1e-4) {
          const inv = 1 / len;
          const dx = seg.x * inv, dy = seg.y * inv, dz = seg.z * inv;
          // …the structure (precise & always current via the voxel grid)
          const gh = this.grid.raycast(f.prev.x, f.prev.y, f.prev.z, seg.x, seg.y, seg.z, len + 0.18);
          let best = Infinity;
          if (gh) {
            best = Math.hypot(gh.point.x - f.prev.x, gh.point.y - f.prev.y, gh.point.z - f.prev.z);
            detonate = true; hx = gh.point.x; hy = gh.point.y; hz = gh.point.z;
          }
          // …or any DYNAMIC object: crates, debris, other projectiles (the building is fixed and
          // already covered above; exclude the projectile's own body)
          const ray = new RAPIER.Ray({ x: f.prev.x, y: f.prev.y, z: f.prev.z }, { x: dx, y: dy, z: dz });
          const oh = this.physics.world.castRay(ray, len + 0.18, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED, undefined, undefined, f.body);
          if (oh && oh.timeOfImpact < best) {
            detonate = true;
            hx = f.prev.x + dx * oh.timeOfImpact; hy = f.prev.y + dy * oh.timeOfImpact; hz = f.prev.z + dz * oh.timeOfImpact;
          }
        }
        // …or on actually touching ANYTHING (walls, ground, crates, debris). This is the reliable
        // catch: physics resolves the collision before we get here, so a fast hit that the swept
        // ray misses would otherwise just bounce. Contact ⇒ detonate (and restitution 0 ⇒ no bounce).
        if (!detonate && f.armed <= 0) {
          this.physics.world.contactPairsWith(f.collider, () => { detonate = true; });
        }
      } else {
        // grenade: stick to the first surface it touches, then count down the fuse
        if (!f.stuck) {
          const seg = new THREE.Vector3().subVectors(cur, f.prev);
          const len = seg.length();
          let sx = cur.x, sy = cur.y, sz = cur.z, stick = false;
          if (len > 1e-4) {
            const hit = this.grid.raycast(f.prev.x, f.prev.y, f.prev.z, seg.x, seg.y, seg.z, len + 0.13);
            if (hit) { sx = hit.point.x; sy = hit.point.y; sz = hit.point.z; stick = true; }
          }
          if (!stick && cur.y <= 0.13) { sy = 0.13; stick = true; }
          if (stick) {
            f.stuck = true;
            cur.set(sx, sy, sz);
            hx = sx; hy = sy; hz = sz;
            f.mesh.position.set(sx, sy, sz);
            f.body.setTranslation({ x: sx, y: sy, z: sz }, true);
            f.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            f.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            f.body.setGravityScale(0, true);
          }
        }
        f.fuse -= dt;
        if (f.fuse <= 0) detonate = true;
      }

      if (f.life <= 0) detonate = true;

      f.prev.copy(cur);

      if (detonate) {
        // remove BEFORE the blast: the blast cooks off nearby missiles (detonateNear), and this
        // one must already be gone so it can't re-detonate itself.
        this.physics.world.removeRigidBody(f.body);
        this.scene.remove(f.mesh);
        this.list.splice(i, 1);
        if (!f.ghost) this.explode(hx, hy, hz, f.radius, f.power); // ghosts are visual only
      }
    }
  }

  /** Cooks off any live missile whose body is within `radius` of a blast — i.e. it's set off by
   *  another explosion (a chain reaction). The rocket is removed BEFORE its own blast fires so the
   *  recursive explosion can't re-detonate the same one. */
  detonateNear(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      if (f.kind !== "rocket" || f.ghost) continue; // a rocket's owner cooks off its own missiles
      const t = f.body.translation();
      const dx = t.x - x, dy = t.y - y, dz = t.z - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      this.physics.world.removeRigidBody(f.body);
      this.scene.remove(f.mesh);
      this.list.splice(i, 1);
      this.explode(t.x, t.y, t.z, f.radius, f.power);
    }
  }
}
