import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { GRAVITY } from "../config";
import type { Physics } from "./physics";
import type { Input } from "./input";

const SENS = 0.0022;
const HALF = 0.55, RADIUS = 0.3; // capsule → ~1.7 m tall human
const EYE = 0.6;                 // camera above the capsule centre (roughly eye level)
const WALK = 4.5, RUN = 7.5;     // m/s
const JUMP = 4.6;                // m/s launch → ~1 m hop
const STEP = 0.35;               // max autostep height (climbs the 0.25 m voxel stairs)

const _add = new THREE.Vector3();

/**
 * Walking-human controller: gravity + jump + capsule-vs-voxel collision. Uses a Rapier kinematic
 * capsule and a character controller with autostep (to climb the voxel stairs) and snap-to-ground,
 * moving against the same voxel colliders that are streamed near the player. Look is mouse-driven;
 * WASD move horizontally only (no flying). The core `move()` is pure of camera/input so it can be
 * unit-tested against a bare Rapier world.
 */
export class Walker {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private pitch = 0;
  private vy = 0;            // vertical velocity (gravity/jump)
  private grounded = false;
  private jumpWasDown = false; // for rising-edge jump (no bunny-hop while the key is held)

  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly onResize: () => void;

  constructor(physics: Physics) {
    this.world = physics.world;
    const aspect = typeof window !== "undefined" ? window.innerWidth / window.innerHeight : 1.5;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.05, 250);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(HALF, RADIUS).setFriction(0.0), this.body,
    );

    const c = physics.world.createCharacterController(0.05);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.enableAutostep(STEP, 0.1, true); // climb steps up to STEP high (the stairs)
    c.enableSnapToGround(STEP);        // stick to stairs/slopes going down
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
    this.world.removeRigidBody(this.body);
  }

  spawn(x: number, y: number, z: number, yaw = 0): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.vy = 0;
    this.yaw = yaw;
    this.camera.position.set(x, y + EYE, z);
    this.lookFromAngles();
  }

  forward(out: THREE.Vector3): THREE.Vector3 { return this.camera.getWorldDirection(out); }
  get position(): { x: number; y: number; z: number } { return this.body.translation(); }
  get isGrounded(): boolean { return this.grounded; }

  /**
   * Advance one tick: apply gravity/jump, move by a desired horizontal velocity (world m/s),
   * and let the character controller resolve collisions. The kinematic target is set here; the
   * world step (elsewhere / in tests) actually moves the body. Returns nothing — read `position`
   * and `isGrounded` after the world steps.
   */
  move(dt: number, vx: number, vz: number, jump: boolean): void {
    if (jump && !this.jumpWasDown && this.grounded) this.vy = JUMP; // only on a fresh press
    this.jumpWasDown = jump;
    this.vy += GRAVITY * dt;
    // snap-to-ground would yank a small upward jump step back down, so disable it while rising;
    // re-enable when falling so we still hug the stairs on the way down.
    if (this.vy > 0) this.controller.disableSnapToGround();
    else this.controller.enableSnapToGround(STEP);
    const desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0; // landed → stop falling
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
  }

  update(dt: number, input: Input): void {
    if (input.locked) {
      const d = input.consumeMouseDelta();
      this.yaw -= d.x * SENS;
      this.pitch -= d.y * SENS;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);   // horizontal forward
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);  // horizontal right
    let dx = 0, dz = 0;
    if (input.isDown("keyw")) { dx += fx; dz += fz; }
    if (input.isDown("keys")) { dx -= fx; dz -= fz; }
    if (input.isDown("keyd")) { dx += rx; dz += rz; }
    if (input.isDown("keya")) { dx -= rx; dz -= rz; }
    const len = Math.hypot(dx, dz);
    const speed = (input.isDown("shiftleft") || input.isDown("shiftright")) ? RUN : WALK;
    const vx = len > 1e-4 ? (dx / len) * speed : 0;
    const vz = len > 1e-4 ? (dz / len) * speed : 0;

    this.move(dt, vx, vz, input.isDown("space"));

    const p = this.body.translation();
    this.camera.position.set(p.x, p.y + EYE, p.z);
    this.lookFromAngles();
  }

  private lookFromAngles(): void {
    const cp = Math.cos(this.pitch);
    _add.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.camera.lookAt(this.camera.position.clone().add(_add));
  }
}
