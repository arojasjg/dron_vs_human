import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { GRAVITY } from "../config";
import type { Physics } from "./physics";
import type { Input } from "./input";
import { headBob, HUMAN_FOV } from "./cameraFeel";
import { stanceInfo, type Stance } from "../net/humanPose";
import { windowVault } from "../net/windowVault";
import type { VoxelGrid } from "../world/voxelGrid";

const SENS = 0.0022;
const HALF = 0.55, RADIUS = 0.3; // capsule → ~1.7 m tall human
const EYE = 0.6;                 // camera above the capsule centre (roughly eye level)
const WALK = 9.0, RUN = 15.0;    // m/s
// Sprint stamina: running drains it, standing/walking regenerates it; empty → forced to walk until it climbs
// back past STAM_RECOVER. Tuned for ~4 s of sprint and a ~5-6 s recovery.
const STAM_DRAIN = 0.26, STAM_REGEN = 0.18, STAM_RECOVER = 0.3;
const JUMP = 4.6;                // m/s launch → ~1 m hop
const STEP = 0.35;               // max autostep height (climbs the 0.25 m voxel stairs)
const CAM_SMOOTH = 0.30;         // camera-height easing → smooth stair descent (body stays on the steps)
const BOB_FREQ = 1.4;            // head-bob phase advance per metre walked
const FEET = HALF + RADIUS;      // capsule centre -> foot contact point
const CLIMB_DUR = 0.8;           // seconds to clamber through a window (movement locked meanwhile)

const _add = new THREE.Vector3();

/** World-space rectangle the human is confined to (the forest ring's inner faces). Keeps a soldier from
 *  escaping the sealed map by climbing a perimeter building and jumping the treeline. Omitted in unit
 *  tests (no confinement). Structural type → the game passes PLAY_BOUNDS from the world builder. */
export interface PlayBounds { minX: number; maxX: number; minZ: number; maxZ: number; }

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
  private fallPeakY = 0;    // highest y reached since leaving the ground (for fall damage)
  private lastFall = 0;     // drop distance of the most recent landing (consumed by the game)
  private smoothCamY = 0;   // eased camera height (decouples the view from the stepped body)
  private bobPhase = 0;     // head-bob phase, advanced by distance walked
  private stance: Stance = 0; // 0 stand · 1 crouch · 2 prone
  private prone = false;    // prone is a toggle (Z); crouch is a hold (Ctrl)
  private proneWasDown = false;
  private smoothEye = EYE;  // eased eye height so changing stance glides instead of snapping
  private readonly grid?: VoxelGrid; // read by the window-vault detector (optional; tests omit it)
  private readonly bounds?: PlayBounds; // playable-area seal (optional; tests omit it → no confinement)
  private adsFov: number | null = null; // aim-down-sights zoom FOV (scoped weapon); null = hip-fire (base FOV)
  private speedMul = 1;              // per-class walk/run multiplier (scout > 1, heavy < 1)
  private stamina = 1;              // 0..1 sprint reserve
  private exhausted = false;        // spent → locked out of RUN until stamina recovers past STAM_RECOVER
  get staminaFrac(): number { return this.stamina; }   // HUD
  get sprintExhausted(): boolean { return this.exhausted; }
  private jumpMul = 1;               // per-class jump multiplier
  private climbing = false;          // mid window-vault: movement input is ignored, body is scripted
  private climbT = 0;
  private climbFrom = { x: 0, y: 0, z: 0 };
  private climbTo = { x: 0, y: 0, z: 0 };
  private climbCooldown = 0;
  // audio events — the game reads + clears these each frame to play footstep/jump/land SFX
  audioStep = false; audioJump = false; audioLand = false; audioRun = false;
  private prevStepIdx = 0;
  private wasGrounded = true;

  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly onResize: () => void;

  constructor(physics: Physics, grid?: VoxelGrid, bounds?: PlayBounds) {
    this.world = physics.world;
    this.grid = grid;
    this.bounds = bounds;
    const aspect = typeof window !== "undefined" ? window.innerWidth / window.innerHeight : 1.5;
    this.camera = new THREE.PerspectiveCamera(HUMAN_FOV, aspect, 0.05, 250);

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
    this.fallPeakY = y; this.smoothCamY = y; this.lastFall = 0;
    this.prone = false; this.stance = 0; this.smoothEye = EYE; // always respawn standing
    this.stamina = 1; this.exhausted = false;                  // fresh legs on respawn
    this.climbing = false; this.climbCooldown = 0;             // never respawn mid-vault
    this.yaw = yaw;
    this.camera.position.set(x, y + EYE, z);
    this.lookFromAngles();
  }

  /** Distance of the most recent landing's fall (metres), consumed once by the game for fall damage. */
  takeFall(): number { const f = this.lastFall; this.lastFall = 0; return f; }

  forward(out: THREE.Vector3): THREE.Vector3 { return this.camera.getWorldDirection(out); }
  get position(): { x: number; y: number; z: number } { return this.body.translation(); }
  get isGrounded(): boolean { return this.grounded; }
  get lookYaw(): number { return this.yaw; }        // broadcast so the avatar body yaws (only) to match
  get lookPitch(): number { return this.pitch; }    // broadcast so only the avatar's head/arms pitch
  get stanceVal(): Stance { return this.stance; }

  /**
   * Advance one tick: apply gravity/jump, move by a desired horizontal velocity (world m/s),
   * and let the character controller resolve collisions. The kinematic target is set here; the
   * world step (elsewhere / in tests) actually moves the body. Returns nothing — read `position`
   * and `isGrounded` after the world steps.
   */
  move(dt: number, vx: number, vz: number, jump: boolean): void {
    if (jump && !this.jumpWasDown && this.grounded) { this.vy = JUMP * this.jumpMul; this.audioJump = true; } // only on a fresh press
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
    if (this.grounded && !this.wasGrounded && this.vy < -2) this.audioLand = true; // touched down after a fall
    this.wasGrounded = this.grounded;
    if (this.grounded && this.vy < 0) this.vy = 0;     // landed → stop falling
    const t = this.body.translation();
    // fall tracking: hold the peak height while airborne; on landing, record the drop for fall damage.
    // A stair descent stays GROUNDED (the body hugs each step), so the peak resets every frame and the
    // recorded drop is only ~one step — never a false fall. A real fall accumulates the whole height.
    if (this.grounded) {
      const fell = this.fallPeakY - t.y;
      if (fell > 0.02) this.lastFall = fell;
      this.fallPeakY = t.y;
    } else {
      this.fallPeakY = Math.max(this.fallPeakY, t.y);
    }
    let nx = t.x + m.x, nz = t.z + m.z;
    // Hard playable-area seal: the hedge stops you on the ground, but a roof-jump could clear it — clamp the
    // XZ target to the ring's inner faces (radius-inset) so no climb/jump at any height carries you out.
    const b = this.bounds;
    if (b) {
      nx = Math.min(b.maxX - RADIUS, Math.max(b.minX + RADIUS, nx));
      nz = Math.min(b.maxZ - RADIUS, Math.max(b.minZ + RADIUS, nz));
    }
    this.body.setNextKinematicTranslation({ x: nx, y: t.y + m.y, z: nz });
  }

  /** Aim-down-sights: pass a scoped weapon's zoom FOV to scope in, or null to zoom back out. Steadies the
   *  aim (look sensitivity scales down with the zoom) and slows the walk while scoped. */
  setAds(fov: number | null): void { this.adsFov = fov; }
  /** Per-class movement tuning: scales walk/run speed and jump launch (1 = the base soldier). */
  setClassMods(speedMul: number, jumpMul: number): void { this.speedMul = speedMul; this.jumpMul = jumpMul; }
  /** Whether the sights are (nearly) scoped in — the game gates the scope overlay on this. */
  get aiming(): boolean { return this.adsFov != null; }

  update(dt: number, input: Input): void {
    if (input.locked) {
      const d = input.consumeMouseDelta();
      // aiming a scope STEADIES the look: sensitivity scales with the optical zoom (the scope circle
      // magnifies, so a small turn moves a lot inside it). The main camera FOV is left UNCHANGED — the
      // zoom is a separate circular scope render (renderer.renderScope), so the periphery stays 1×.
      const sens = SENS * ((this.adsFov ?? HUMAN_FOV) / HUMAN_FOV);
      this.yaw -= d.x * sens;
      this.pitch -= d.y * sens;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }

    this.climbCooldown -= dt;
    if (this.climbing) { this.updateClimb(dt); return; } // mid-vault: all movement input ignored
    // start a window vault: grounded, pushing forward, and a glassless window right ahead
    const g = this.grid;
    if (g && this.grounded && this.climbCooldown <= 0 && input.isDown("keyw")) {
      const c = this.body.translation();
      const t = windowVault((x, y, z) => g.has(x, y, z), c.x, c.y - FEET, c.z, Math.sin(this.yaw), Math.cos(this.yaw));
      if (t) {
        this.climbing = true; this.climbT = 0;
        this.climbFrom = { x: c.x, y: c.y, z: c.z };
        this.climbTo = { x: t.x, y: t.y + FEET, z: t.z };
        this.updateClimb(dt); return;
      }
    }

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);   // horizontal forward
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);  // horizontal right
    let dx = 0, dz = 0;
    if (input.isDown("keyw")) { dx += fx; dz += fz; }
    if (input.isDown("keys")) { dx -= fx; dz -= fz; }
    if (input.isDown("keyd")) { dx += rx; dz += rz; }
    if (input.isDown("keya")) { dx -= rx; dz -= rz; }
    // stance: Z toggles prone, holding Ctrl crouches; each lowers the eye + slows movement
    const proneKey = input.isDown("keyz");
    if (proneKey && !this.proneWasDown) this.prone = !this.prone;
    this.proneWasDown = proneKey;
    const crouch = input.isDown("keyc"); // crouch (C — Ctrl would fire browser Ctrl+W/Ctrl+digit)
    this.stance = this.prone ? 2 : crouch ? 1 : 0;
    const si = stanceInfo(this.stance);

    const len = Math.hypot(dx, dz);
    const adsSlow = this.adsFov != null ? 0.55 : 1; // scoped in → move slower (steady the shot)
    // sprint gated by stamina: drains while actually running, regenerates otherwise; empty → forced walk until recovered
    const wantSprint = input.isDown("shiftleft") || input.isDown("shiftright");
    const sprinting = wantSprint && len > 1e-4 && !this.exhausted && this.stamina > 0;
    if (sprinting) { this.stamina = Math.max(0, this.stamina - STAM_DRAIN * dt); if (this.stamina === 0) this.exhausted = true; }
    else { this.stamina = Math.min(1, this.stamina + STAM_REGEN * dt); if (this.exhausted && this.stamina >= STAM_RECOVER) this.exhausted = false; }
    const speed = (sprinting ? RUN : WALK) * si.speedMul * adsSlow * this.speedMul;
    const vx = len > 1e-4 ? (dx / len) * speed : 0;
    const vz = len > 1e-4 ? (dz / len) * speed : 0;

    this.move(dt, vx, vz, input.isDown("space"));

    const p = this.body.translation();
    // ease the camera's HEIGHT toward the body so descending the stepped stairs glides instead of
    // lurching one step at a time; snap it for big deltas (jumps/falls/teleports) to avoid lag.
    this.smoothCamY += (p.y - this.smoothCamY) * CAM_SMOOTH;
    if (Math.abs(p.y - this.smoothCamY) > 1.2) this.smoothCamY = p.y;
    // body-cam head-bob: advance the stride phase by ground distance, then offset the camera (lateral
    // sway along the facing-right axis, vertical bob, slight roll). No bob while airborne.
    const spd = this.grounded ? Math.hypot(vx, vz) : 0;
    this.bobPhase += spd * dt * BOB_FREQ;
    const stepIdx = Math.floor(this.bobPhase / Math.PI);          // one footfall per π of walk phase
    if (stepIdx !== this.prevStepIdx && this.grounded && spd > 0.6) this.audioStep = true;
    this.prevStepIdx = stepIdx;
    this.audioRun = spd > 12;
    const bob = headBob(this.bobPhase, spd, RUN);
    this.smoothEye += (si.eye - this.smoothEye) * (1 - Math.exp(-8 * dt)); // glide between stance eye heights
    this.camera.position.set(p.x + bob.dx * rx, this.smoothCamY + this.smoothEye + bob.dy, p.z + bob.dx * rz);
    this.lookFromAngles();
    this.camera.rotateZ(bob.roll);
  }

  /** Drives the body along the scripted window-vault: a straight lerp to the far side with a small
   *  arc to clear the sill. No collision (kinematic set-translation passes through the opening), no
   *  movement input, no head-bob — the player is locked until they land inside. */
  private updateClimb(dt: number): void {
    this.climbT += dt;
    const u = Math.min(1, this.climbT / CLIMB_DUR);
    const arc = Math.sin(u * Math.PI) * 0.35; // rise over the sill, then settle
    const x = this.climbFrom.x + (this.climbTo.x - this.climbFrom.x) * u;
    const y = this.climbFrom.y + (this.climbTo.y - this.climbFrom.y) * u + arc;
    const z = this.climbFrom.z + (this.climbTo.z - this.climbFrom.z) * u;
    this.body.setNextKinematicTranslation({ x, y, z });
    this.vy = 0; this.grounded = true; this.stance = 3; // 3 = climbing pose (broadcast to peers)
    if (u >= 1) {
      this.climbing = false; this.climbCooldown = 0.5;
      this.body.setTranslation(this.climbTo, true);
      this.fallPeakY = this.climbTo.y;
    }
    this.smoothCamY += (y - this.smoothCamY) * 0.5;
    this.smoothEye += (stanceInfo(3).eye - this.smoothEye) * (1 - Math.exp(-8 * dt));
    this.camera.position.set(x, this.smoothCamY + this.smoothEye, z);
    this.lookFromAngles();
  }

  private lookFromAngles(): void {
    const cp = Math.cos(this.pitch);
    _add.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.camera.lookAt(this.camera.position.clone().add(_add));
  }
}
