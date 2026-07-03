import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { Physics } from "./physics";
import type { Input } from "./input";
import { droneBank, hoverSway, speedFov, DRONE_FOV_BASE, DRONE_FOV_BOOST } from "./cameraFeel";

const SENS = 0.0022;
const CRUISE = 9.0;        // m/s normal flight speed
const BOOST = 20.0;        // m/s with shift held
const RESPONSE = 6.5;      // how fast velocity chases the target (drone inertia: lower = floatier)
const VERT_SCALE = 0.65;   // a drone climbs/descends slower than it translates (rotor thrust limit)
const EYE = 0.0;     // camera sits at the drone body centre
const RADIUS = 0.18; // small spherical drone (Ø0.36m) → fits through 3-voxel (0.75m) windows

const _look = new THREE.Vector3();
const _add = new THREE.Vector3();

/**
 * Flying-drone controller: free 6-DOF flight with no gravity. W/S fly along the look direction,
 * A/D strafe horizontally, Space/Ctrl rise/descend. Velocity eases toward the input target so the
 * drone has a bit of inertia (accelerates and drifts to a stop). A small kinematic capsule + the
 * character controller keep it from flying through walls (it slides along them instead).
 */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private pitch = 0;
  private readonly vel = new THREE.Vector3();
  private lastBlocked = 0;   // fraction of the last move blocked by a wall (1 = fully stopped)
  private lastSpeedH = 0;    // horizontal speed on the last frame (m/s)
  private time = 0;          // accumulates dt for the idle hover sway

  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly onResize: () => void;

  constructor(physics: Physics) {
    this.world = physics.world;
    const aspect = typeof window !== "undefined" ? window.innerWidth / window.innerHeight : 1.5;
    this.camera = new THREE.PerspectiveCamera(DRONE_FOV_BASE, aspect, 0.05, 250);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.ball(RADIUS).setFriction(0.0),
      this.body,
    );

    // a flying controller: collide & slide on walls, but NO snap-to-ground or autostep (it hovers)
    const c = physics.world.createCharacterController(0.05);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setApplyImpulsesToDynamicBodies(true);
    this.controller = c;

    this.onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    if (typeof window !== "undefined") window.addEventListener("resize", this.onResize);
  }

  /** Removes this controller's physics bodies + resize listener (used when swapping drone↔human). */
  dispose(): void {
    if (typeof window !== "undefined") window.removeEventListener("resize", this.onResize);
    this.world.removeCharacterController(this.controller);
    this.world.removeRigidBody(this.body); // also removes its attached collider
  }

  /** Places the drone at a world position and stops it. */
  spawn(x: number, y: number, z: number, yaw = 0): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.camera.position.set(x, y + EYE, z);
    this.lookFromAngles();
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  /** The last frame's horizontal speed + how hard it was wall-blocked, consumed once for impact damage. */
  takeImpact(): { speed: number; blocked: number } {
    const r = { speed: this.lastSpeedH, blocked: this.lastBlocked };
    this.lastSpeedH = 0; this.lastBlocked = 0;
    return r;
  }

  /** Current 3D speed (m/s) — drives the drone's battery drain (faster = more). */
  speed(): number { return Math.hypot(this.vel.x, this.vel.y, this.vel.z); }

  // Uniform aim/stance accessors so Game broadcasts the same fields for drone + human (drone: no stance).
  get lookYaw(): number { return this.yaw; }
  get lookPitch(): number { return this.pitch; }
  get stanceVal(): 0 { return 0; }

  update(dt: number, input: Input): void {
    if (input.locked) {
      const d = input.consumeMouseDelta();
      this.yaw -= d.x * SENS;
      this.pitch -= d.y * SENS;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }

    const cp = Math.cos(this.pitch);
    _look.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp); // full look dir
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);                            // horizontal right

    // build the input direction (fly where you look on W/S, strafe + vertical on the rest)
    let dx = 0, dy = 0, dz = 0;
    if (input.isDown("keyw")) { dx += _look.x; dy += _look.y; dz += _look.z; }
    if (input.isDown("keys")) { dx -= _look.x; dy -= _look.y; dz -= _look.z; }
    if (input.isDown("keyd")) { dx += rx; dz += rz; }
    if (input.isDown("keya")) { dx -= rx; dz -= rz; }
    if (input.isDown("space")) dy += 1;
    if (input.isDown("keyc")) dy -= 1; // descend (C — Ctrl would trigger browser Ctrl+W/Ctrl+digit)

    const len = Math.hypot(dx, dy, dz);
    const speed = (input.isDown("shiftleft") || input.isDown("shiftright")) ? BOOST : CRUISE;
    const tx = len > 1e-4 ? (dx / len) * speed : 0;
    const ty = len > 1e-4 ? (dy / len) * speed * VERT_SCALE : 0; // drones climb/descend slower
    const tz = len > 1e-4 ? (dz / len) * speed : 0;

    // ease velocity toward the target → smooth accelerate / drift to stop (drone inertia)
    const k = 1 - Math.exp(-RESPONSE * dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.y += (ty - this.vel.y) * k;
    this.vel.z += (tz - this.vel.z) * k;

    const desired = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    const corr = this.controller.computedMovement();
    // hard-impact: how much of the intended horizontal move was blocked by a wall, and how fast.
    const dH = Math.hypot(desired.x, desired.z), aH = Math.hypot(corr.x, corr.z);
    this.lastBlocked = dH > 1e-4 ? 1 - aH / dH : 0;
    this.lastSpeedH = Math.hypot(this.vel.x, this.vel.z);
    // crash → bleed off speed so a wall-pinned drone isn't hit every frame. INVARIANT: this 12 must
    // stay BELOW falldamage's IMPACT_MIN (14) — the re-eased speed then never re-crosses 14 → one hit.
    if (this.lastBlocked > 0.6 && this.lastSpeedH > 12) this.vel.multiplyScalar(0.15);
    const t = this.body.translation();
    const np = { x: t.x + corr.x, y: t.y + corr.y, z: t.z + corr.z };
    this.body.setNextKinematicTranslation(np);

    // --- drone camera feel: idle hover sway, bank into lateral motion, FOV that widens with speed ---
    this.time += dt;
    const sway = hoverSway(this.time);
    const rightVel = this.vel.x * rx + this.vel.z * rz;          // lateral speed in the facing frame
    this.camera.position.set(np.x + sway.dx, np.y + EYE + sway.dy, np.z + sway.dx * 0.6);
    this.lookFromAngles();
    this.camera.rotateZ(droneBank(rightVel, BOOST) + sway.roll); // roll around forward → aim direction unchanged
    const fov = speedFov(DRONE_FOV_BASE, DRONE_FOV_BOOST, this.lastSpeedH, BOOST);
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-6 * dt));
    this.camera.updateProjectionMatrix();
  }

  private lookFromAngles(): void {
    const cp = Math.cos(this.pitch);
    _add.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.camera.lookAt(this.camera.position.clone().add(_add));
  }
}
