import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { classStats, TEAM_COLOR, type Role } from "./roles";
import { MODEL_CONFIGS, type AvatarModelConfig } from "./avatarModels";
import type { Physics } from "../engine/physics";
import { legSwing, stanceInfo, type Stance } from "./humanPose";
import { instanceModel, pickAction, type ModelInstance } from "../engine/modelLoader";

export const MAX_HP = 100;

/** Yaw (radians) that makes a +Z-facing model point along the XZ velocity (dx,dz). atan2(dx,dz) maps the
 *  model's forward (+Z) onto the movement direction. Pure. */
export function facingYawFromVelocity(dx: number, dz: number): number { return Math.atan2(dx, dz); }

// Rigged + animated glTF avatars (soldier = "Soldier.glb" by kupvom CC-BY 4.0; drone near-LOD/preview =
// RobotExpressive.glb) — replace the procedural rig/quadcopter when loaded; fall back to procedural on any
// load failure. Scale/offset/facing/clip names live in MODEL_CONFIGS (avatarModels.ts).

interface Remote {
  drone: THREE.Group;  // quadcopter avatar (role "drone"), positioned at the eye
  rotors: THREE.Mesh[]; // the 4 rotor discs — spun every frame so the copter looks alive
  human: THREE.Group;  // human avatar OUTER group (at the eye) — turns by YAW only, stays upright
  rig: THREE.Group;    // model container, dropped so the feet reach the ground (+ stance rig-lift)
  upper: THREE.Group;  // head + arms + rifle — PITCHES with the aim (not the whole body)
  rifle: THREE.Group;  // swings on a melee (rifle-butt) attack
  legL: THREE.Group;   // hip-pivot legs — swung by the walk cycle
  legR: THREE.Group;
  meleeTimer: number;  // seconds remaining of a melee swing animation
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
  targetPos: THREE.Vector3;    // last received position — the avatar eases toward it each frame
  targetQuat: THREE.Quaternion;
  targetYaw: number;           // body yaw + head/arm pitch, sent separately so the body stays upright
  targetPitch: number;
  stance: Stance;              // 0 stand · 1 crouch · 2 prone
  walkPhase: number;           // walk-cycle phase, advanced by the interpolated ground distance
  prevX: number; prevZ: number;
  isHuman: boolean;
  team: number;                // PvP team (0/1) — drives friend/enemy + the teammates panel
  cls: string;                 // chosen class id — drives the avatar tint
  tintMat: THREE.MeshStandardMaterial; // per-instance accent: colour = class, emissive glow = team
  frac: number;                // hp fraction for the health bar
  hp: number;                  // raw hp/maxHp — for the teammates panel
  maxHp: number;
  aimX?: number; aimZ?: number; // this peer's OWN aim dir (XZ, from its state broadcast) — undefined until it sends one, so a legacy peer stays "not aiming" for the swarm's dodge gate
  kills: number; assists: number; deaths: number; // this peer's own K/A/D (from its state broadcast) — for the scoreboard; 0 for a legacy peer that doesn't send them
  lastSeen: number;
  model: ModelInstance | null;   // rigged soldier glTF (null until loaded / if it failed → procedural rig)
  modelReq: boolean;             // load kicked off (only for humans, once)
  curClip: string;               // current animation clip, for crossfading
  body: RAPIER.RigidBody;        // kinematic collider that follows the avatar so debris/weapons don't pass through it
}

const LERP = 18;               // interpolation rate → smooths the ~20 Hz network samples into 60 fps motion
const SNAP_DIST = 6;           // metres: a jump farther than this is a teleport/respawn → snap, don't slide
const RIG_DROP = -0.55;        // the model hangs this far below the eye so the feet reach the ground
const UPPER_PIVOT = 0.42;      // neck/shoulder height the head+arms pitch about
const HIP_PIVOT = -0.2;        // hip height the legs swing about
const WALK_FREQ = 1.7;         // walk-phase advance per metre travelled
const HUMAN_RUN = 7.5;         // matches Walker RUN — scales the leg swing amplitude

// per-frame scratch: consumed synchronously by the caller / Rapier before the next use
const KIN_POS = { x: 0, y: 0, z: 0 };
const NEAREST = { dist: 0, x: 0, z: 0 };
const TARGET_POOL: { id: number; x: number; y: number; z: number; hp: number; maxHp: number; aimX?: number; aimZ?: number }[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const FACE_Q = new THREE.Quaternion(); // yaw-only scratch: face an identity-quat bot along its velocity (no per-drone/frame alloc)

// --- Drone: detailed military quadcopter (~0.95 m span) ---
const D_CORE = new THREE.BoxGeometry(0.34, 0.12, 0.52);          // fuselage
const D_DECK = new THREE.BoxGeometry(0.26, 0.07, 0.34);          // raised avionics deck
const D_GIMBAL = new THREE.SphereGeometry(0.085, 14, 10);        // camera ball underneath
const D_LENS = new THREE.CylinderGeometry(0.045, 0.055, 0.05, 12);
const D_DOME = new THREE.SphereGeometry(0.1, 14, 8);             // top sensor dome
const D_ARM = new THREE.BoxGeometry(0.52, 0.035, 0.06);          // boom
const D_MOTOR = new THREE.CylinderGeometry(0.05, 0.06, 0.09, 12);
const D_ROTOR = new THREE.CylinderGeometry(0.2, 0.2, 0.012, 20); // rotor disc (spins → motion-blur look)
const D_BLADE = new THREE.BoxGeometry(0.4, 0.006, 0.03);         // a solid blade bar spun with the rotor
const D_HUB = new THREE.CylinderGeometry(0.028, 0.028, 0.05, 8);
const D_SKID = new THREE.BoxGeometry(0.028, 0.028, 0.4);         // landing skid rail
const D_SKIDLEG = new THREE.BoxGeometry(0.025, 0.12, 0.025);
const D_LIGHT = new THREE.SphereGeometry(0.022, 8, 6);           // nav light
const D_ANT = new THREE.CylinderGeometry(0.006, 0.006, 0.17, 6); // antenna
const D_BEACON = new THREE.BoxGeometry(0.13, 0.055, 0.13);      // class/team beacon atop the drone

// --- Soldier: detailed infantry (~1.7 m, centred at the capsule origin) ---
const H_HIPS = new THREE.BoxGeometry(0.36, 0.2, 0.24);
const H_TORSO = new THREE.BoxGeometry(0.42, 0.5, 0.26);
const H_VEST = new THREE.BoxGeometry(0.46, 0.44, 0.31);         // plate carrier
const H_POUCH = new THREE.BoxGeometry(0.1, 0.1, 0.07);
const H_NECK = new THREE.CylinderGeometry(0.06, 0.07, 0.08, 8);
const H_HEAD = new THREE.SphereGeometry(0.12, 12, 10);
const H_HELMET = new THREE.SphereGeometry(0.16, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.62);
const H_VISOR = new THREE.BoxGeometry(0.21, 0.05, 0.05);
const H_SHOULDER = new THREE.SphereGeometry(0.1, 10, 8);
const H_UARM = new THREE.BoxGeometry(0.12, 0.3, 0.12);
const H_LARM = new THREE.BoxGeometry(0.1, 0.28, 0.1);
const H_GLOVE = new THREE.BoxGeometry(0.1, 0.09, 0.1);
const H_THIGH = new THREE.BoxGeometry(0.15, 0.36, 0.16);
const H_SHIN = new THREE.BoxGeometry(0.13, 0.34, 0.14);
const H_KNEE = new THREE.SphereGeometry(0.075, 8, 6);
const H_BOOT = new THREE.BoxGeometry(0.14, 0.12, 0.26);
const H_PACK = new THREE.BoxGeometry(0.3, 0.42, 0.16);
const H_BAND = new THREE.BoxGeometry(0.48, 0.09, 0.33);        // class/team sash around the torso
const H_PACKTOP = new THREE.CylinderGeometry(0.08, 0.08, 0.3, 8);
// rifle held across the chest
const R_BODY = new THREE.BoxGeometry(0.06, 0.1, 0.42);
const R_BARREL = new THREE.CylinderGeometry(0.017, 0.017, 0.34, 8);
const R_MAG = new THREE.BoxGeometry(0.05, 0.17, 0.06);
const R_STOCK = new THREE.BoxGeometry(0.05, 0.09, 0.18);
const R_SIGHT = new THREE.BoxGeometry(0.03, 0.06, 0.08);

/** Renders the other players: a quadcopter for drones and a figure for humans, each with a
 *  billboarded health bar. The avatar shown follows each peer's broadcast role. */
export class RemoteDrones {
  private readonly drones = new Map<number, Remote>();
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.38, metalness: 0.88 }); // polished gunmetal — sharper specular
  private readonly carbonMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.32, metalness: 0.65 }); // carbon fibre
  private readonly domeMat = new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.18, metalness: 0.55, emissive: 0x06121e, emissiveIntensity: 0.6 }); // sensor dome with a faint glow
  private readonly lensMat = new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.08, metalness: 0.25, emissive: 0x3a1cc0, emissiveIntensity: 1.4 }); // glowing camera lens
  private readonly rotorMat = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.8, transparent: true, opacity: 0.5 });
  private readonly redLight = new THREE.MeshStandardMaterial({ color: 0xff2a1e, emissive: 0xff1808, emissiveIntensity: 2.2, roughness: 0.4 }); // punchy nav lights
  private readonly greenLight = new THREE.MeshStandardMaterial({ color: 0x2bff44, emissive: 0x18ff33, emissiveIntensity: 2.2, roughness: 0.4 });
  private readonly fatigueMat = new THREE.MeshStandardMaterial({ color: 0x4a5238, roughness: 0.9 }); // olive fatigues
  private readonly gearMat = new THREE.MeshStandardMaterial({ color: 0x2b3024, roughness: 0.85 });   // vest/helmet/pack
  private readonly skinMat = new THREE.MeshStandardMaterial({ color: 0x8a6b50, roughness: 0.8 });
  private readonly gunMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.5, metalness: 0.6 });
  private readonly visorMat = new THREE.MeshStandardMaterial({ color: 0x121a22, roughness: 0.15, metalness: 0.3, emissive: 0x08222a });
  private readonly bootMat = new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.9 });

  private warm?: () => void; // background shader prewarm, fired after each avatar model mounts

  constructor(private readonly scene: THREE.Scene, private readonly physics: Physics) {}

  /** Hook called after each glTF avatar mounts, so the game can prewarm its shaders off the first render. */
  setWarm(fn: () => void): void { this.warm = fn; }

  get count(): number { return this.drones.size; }

  /** Positions of ENEMY peers (opposite team, or everyone in free-for-all) — for local hit prediction so
   *  the shooter gets a hit marker even though damage is applied authoritatively on the victim. */
  enemyPositions(myTeam: number, freeForAll: boolean, out: { x: number; y: number; z: number }[]): void {
    out.length = 0;
    for (const d of this.drones.values())
      if (freeForAll || d.team !== myTeam) out.push({ x: d.drone.position.x, y: d.drone.position.y, z: d.drone.position.z });
  }

  /** First remote's position (test helper). */
  firstPos(): { x: number; y: number; z: number } | null {
    for (const d of this.drones.values()) return { x: d.drone.position.x, y: d.drone.position.y, z: d.drone.position.z };
    return null;
  }

  /** Nearest ENEMY-drone avatar (role drone): its distance + XZ position, or null if none — lets a human on
   *  the ground HEAR drones (closer = louder/brighter) AND pan the rotor to the side it's on. */
  nearestDrone(x: number, y: number, z: number): { dist: number; x: number; z: number } | null {
    let best = Infinity, bx = 0, bz = 0, found = false;
    for (const d of this.drones.values()) {
      if (d.isHuman) continue;
      const p = d.drone.position, dd = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (dd < best) { best = dd; bx = p.x; bz = p.z; found = true; }
    }
    if (!found) return null;
    NEAREST.dist = best; NEAREST.x = bx; NEAREST.z = bz;
    return NEAREST;
  }

  /** Distance to the nearest enemy drone, or Infinity if none. */
  nearestDroneDist(x: number, y: number, z: number): number {
    return this.nearestDrone(x, y, z)?.dist ?? Infinity;
  }

  /** Loads the rigged soldier glTF for a human peer (once); on success it replaces the procedural rig. */
  private loadHumanModel(d: Remote): void {
    this.loadAvatarModel(d, MODEL_CONFIGS.soldier, d.human);
  }

  /** Generic glTF avatar loader: instances a config, poses it to Idle, mounts it on `mount`, hides the
   *  procedural rig, and stores it on the Remote — or leaves the procedural avatar visible on load failure
   *  (instanceModel resolves null on error). Shared by the soldier and the drone near-LOD robot. */
  private loadAvatarModel(d: Remote, cfg: AvatarModelConfig, mount: THREE.Group): void {
    d.modelReq = true;
    instanceModel(cfg.url).then((m) => {
      if (!m || !mount.parent) return; // load failed, OR the peer was pruned mid-load → no orphan
      m.scene.scale.setScalar(cfg.scale);
      m.scene.position.y = cfg.yOffset;
      m.scene.rotation.y = cfg.rot;
      mount.add(m.scene);
      d.rig.visible = false;                       // hide the hand-built rig
      const idle = pickAction(m.actions, cfg.clips.idle); if (idle) idle.play();
      m.mixer.update(0); // pose to Idle NOW so an avatar that loads while far (LOD-frozen) isn't a bind-pose T-pose
      d.curClip = "Idle";
      d.model = m;                                  // set LAST so update() only drives a fully-ready model
      this.tintModel(d);                            // apply the current team accent to the freshly-loaded materials
      this.warm?.();                                // background-compile its shaders before its first render
    });
  }

  /** Applies this avatar's TEAM accent (an emissive glow) to its loaded glTF's per-instance materials, so a
   *  Rojo/Azul soldier/robot reads at a glance without mutating the shared model cache. No-op if no model yet. */
  private tintModel(d: Remote): void {
    if (!d.model) return;
    const hex = TEAM_COLOR[d.team === 1 ? 1 : 0];
    for (const mm of d.model.materials) { mm.emissive.setHex(hex); mm.emissiveIntensity = 0.32; }
  }

  /** Triggers a rifle-butt swing animation on a peer's avatar (they just melee'd). */
  meleeAnim(id: number): void { const d = this.drones.get(id); if (d) d.meleeTimer = 0.4; }

  /** XZ position + role of every known avatar (peers AND AI bots) for the minimap. The caller decides
   *  friend/enemy from the game mode + its own role. */
  radar(): { x: number; z: number; isHuman: boolean; team: number }[] {
    const out: { x: number; z: number; isHuman: boolean; team: number }[] = [];
    for (const d of this.drones.values()) {
      const p = d.isHuman ? d.human.position : d.drone.position;
      out.push({ x: p.x, z: p.z, isHuman: d.isHuman, team: d.team });
    }
    return out;
  }

  /** Snapshot of every known peer (id, hp, role, team, K/A/D) — the HUD filters to teammates by team
   *  and builds the full scoreboard. */
  peers(): { id: number; hp: number; maxHp: number; isHuman: boolean; team: number; kills: number; assists: number; deaths: number }[] {
    const out: { id: number; hp: number; maxHp: number; isHuman: boolean; team: number; kills: number; assists: number; deaths: number }[] = [];
    for (const [id, d] of this.drones) out.push({ id, hp: d.hp, maxHp: d.maxHp, isHuman: d.isHuman, team: d.team, kills: d.kills, assists: d.assists, deaths: d.deaths });
    return out;
  }

  /** Living HUMAN peers as AI targets (id + eye position), written into `out` (reused, no alloc). Co-op:
   *  the enemy swarm chases every living soldier, not only the host. Skips avatars at hp ≤ 0. */
  humanTargets(out: { id: number; x: number; y: number; z: number; hp: number; maxHp: number; aimX?: number; aimZ?: number }[]): void {
    out.length = 0;
    for (const [id, d] of this.drones) {
      if (!d.isHuman || d.hp <= 0) continue;
      const p = d.human.position;
      let t = TARGET_POOL[out.length];
      if (!t) { t = { id: 0, x: 0, y: 0, z: 0, hp: 0, maxHp: 0 }; TARGET_POOL[out.length] = t; }
      t.id = id; t.x = p.x; t.y = p.y; t.z = p.z; t.hp = d.hp; t.maxHp = d.maxHp;
      t.aimX = d.aimX; t.aimZ = d.aimZ; // possibly undefined → the AI's "being aimed at" gate stays off
      out.push(t);
    }
  }

  upsert(id: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hp: number, role: Role = "drone", maxHp = MAX_HP, yaw = 0, pitch = 0, stance: Stance = 0, team = 0, cls = "", aimX?: number, aimZ?: number, kills = 0, assists = 0, deaths = 0, tintOverride?: number): void {
    let d = this.drones.get(id);
    const isNew = !d;
    if (!d) d = this.create(id);
    d.targetPos.set(x, y, z);              // store the target; the avatar EASES toward it in update()
    d.targetQuat.set(qx, qy, qz, qw);
    d.targetYaw = yaw; d.targetPitch = pitch; d.stance = stance;
    d.aimX = aimX; d.aimZ = aimZ;          // undefined when the peer never sent aim (legacy client)
    d.kills = kills; d.assists = assists; d.deaths = deaths; // 0 for a legacy peer that doesn't broadcast K/A/D
    d.isHuman = role === "human";
    d.team = team; d.cls = cls;
    // accent: class colour on the body, team colour as an emissive glow → drone-vs-drone stays readable
    const st = classStats(d.isHuman ? "human" : "drone", cls);
    d.tintMat.color.setHex(tintOverride ?? st.tint); // AI drones override with a per-archetype hue; human/default path unchanged
    d.tintMat.emissive.setHex(TEAM_COLOR[team === 1 ? 1 : 0]);
    d.tintMat.emissiveIntensity = 0.55;
    this.tintModel(d); // if a glTF model is loaded, give ITS materials the same team accent (per-instance)
    if (d.isHuman && !d.modelReq) this.loadHumanModel(d);
    d.hp = hp; d.maxHp = maxHp;
    d.frac = Math.max(0, Math.min(1, hp / maxHp));
    d.drone.visible = !d.isHuman;
    d.human.visible = d.isHuman;
    (d.barFg.material as THREE.SpriteMaterial).color.setHex(d.frac > 0.5 ? 0x35dd45 : d.frac > 0.25 ? 0xddc233 : 0xdd3a30);
    if (isNew) { // snap first sighting
      d.drone.position.copy(d.targetPos); d.drone.quaternion.copy(d.targetQuat);
      d.human.position.copy(d.targetPos); d.human.rotation.set(0, yaw, 0);
      d.prevX = x; d.prevZ = z;
    }
    d.lastSeen = performance.now();
  }

  /** Per-frame: ease each remote toward its last received transform, so peers glide smoothly between
   *  the ~20 Hz network samples instead of stuttering, and their health bars follow the eased body. */
  update(dt: number, camX?: number, camZ?: number): void {
    const k = 1 - Math.exp(-LERP * dt);
    for (const d of this.drones.values()) {
      // a normal step between 20 Hz samples is < ~1 m; a jump this big is a respawn/teleport → snap it.
      const f = d.drone.position.distanceToSquared(d.targetPos) > SNAP_DIST * SNAP_DIST ? 1 : k;
      // DRONE: PvP drones broadcast a real quaternion (bank/roll) → use it; AI bots send identity (no
      // orientation) → face their travel direction so the swarm doesn't all point +Z and slide sideways.
      const vdx = d.targetPos.x - d.drone.position.x, vdz = d.targetPos.z - d.drone.position.z; // pre-lerp heading
      const moving = vdx * vdx + vdz * vdz > 1e-4; // speed gate: a hovering bot holds its last facing (no jitter spin)
      d.drone.position.lerp(d.targetPos, f);
      if (Math.abs(d.targetQuat.w) > 0.9999) { // w≈±1 ⇒ identity quat ⇒ no real orientation given
        if (moving) { FACE_Q.setFromAxisAngle(UP, facingYawFromVelocity(vdx, vdz)); d.drone.quaternion.slerp(FACE_Q, f); } // smooth turn toward velocity
      } else d.drone.quaternion.slerp(d.targetQuat, f); // PvP drone: use its broadcast orientation (unchanged)
      if (!d.isHuman) for (const r of d.rotors) r.rotation.y += dt * 45; // spinning props → a live copter
      // HUMAN: the body turns by YAW only (stays upright); the head+arms+rifle pitch; legs walk.
      const h = d.human, st = stanceInfo(d.stance);
      h.position.lerp(d.targetPos, f);
      let yd = d.targetYaw - h.rotation.y;                       // shortest-arc yaw ease
      yd = Math.atan2(Math.sin(yd), Math.cos(yd));
      h.rotation.set(st.bodyLean, h.rotation.y + yd * f, 0);     // yaw + stance lean, NEVER a pitch of the body
      d.upper.rotation.x = -d.targetPitch;                       // only the head/arms/weapon aim up/down
      d.rig.position.y = RIG_DROP + st.rigLift;                  // keep the feet on the ground per stance
      // walk cycle from the eased ground distance → legs still when idle, swinging when moving
      const spd = Math.hypot(h.position.x - d.prevX, h.position.z - d.prevZ) / Math.max(1e-4, dt);
      d.prevX = h.position.x; d.prevZ = h.position.z;
      d.walkPhase += spd * dt * WALK_FREQ;
      const sw = legSwing(d.walkPhase, spd, HUMAN_RUN);
      d.legL.rotation.x = st.legBend + sw;
      d.legR.rotation.x = st.legBend - sw;
      // rigged model (if loaded): advance its skeleton + crossfade Idle → Walk → Run from the eased speed.
      // LOD: freeze the animation (skip the costly skinning update) for peers far from the camera.
      if (d.model) {
        const far = camX !== undefined && Math.hypot(h.position.x - camX, h.position.z - (camZ as number)) > 45;
        if (!far) d.model.mixer.update(dt);
        const want = spd > 5 ? "Run" : spd > 0.4 ? "Walk" : "Idle";
        if (want !== d.curClip) {
          const to = pickAction(d.model.actions, want), from = pickAction(d.model.actions, d.curClip);
          if (to) { to.reset().play(); if (from && from !== to) from.crossFadeTo(to, 0.3, false); }
          d.curClip = want;
        }
      }
      // melee: a quick rifle-butt jab arc, then rest
      if (d.meleeTimer > 0) {
        d.meleeTimer = Math.max(0, d.meleeTimer - dt);
        d.rifle.rotation.x = -Math.sin((1 - d.meleeTimer / 0.4) * Math.PI) * 1.5;
      } else if (d.rifle.rotation.x !== 0) {
        d.rifle.rotation.x = 0;
      }
      // health bar above whichever avatar is shown — HIDDEN at full HP: the AI swarm is broadcast at a constant
      // full 100/100, so its bars would ALWAYS show and clutter the view; a peer's bar only appears once hurt.
      const p = d.isHuman ? h.position : d.drone.position;
      const showBar = d.frac < 0.995;
      d.barFg.visible = showBar; d.barBg.visible = showBar;
      if (showBar) {
        d.barFg.scale.set(0.6 * d.frac, 0.08, 1);
        d.barFg.position.set(p.x - 0.3 * (1 - d.frac), p.y + 0.45, p.z);
        d.barBg.position.set(p.x, p.y + 0.45, p.z);
      }
      // follow the eased avatar with the kinematic collider (humans: drop to the torso; drones: at the body)
      KIN_POS.x = p.x; KIN_POS.y = p.y - (d.isHuman ? 0.6 : 0); KIN_POS.z = p.z;
      d.body.setNextKinematicTranslation(KIN_POS);
    }
  }

  /** Drops peers we haven't heard from recently (disconnects). Generous, because a backgrounded tab
   *  pauses its animation loop; the ~1 Hz heartbeat (Game) keeps a merely-idle peer inside this window. */
  prune(now: number = performance.now()): void {
    for (const [id, d] of this.drones) if (now - d.lastSeen > 8000) this.remove(id);
  }

  remove(id: number): void {
    const d = this.drones.get(id);
    if (!d) return;
    this.scene.remove(d.drone, d.human, d.barBg, d.barFg);
    this.physics.world.removeRigidBody(d.body); // also removes its attached collider
    this.drones.delete(id);
  }

  private create(id: number): Remote {
    // --- Drone: military quadcopter with an X-frame, motor pods, gimbal camera, skids & nav lights ---
    const drone = new THREE.Group();
    const core = new THREE.Mesh(D_CORE, this.carbonMat); core.castShadow = true;
    const deck = new THREE.Mesh(D_DECK, this.bodyMat); deck.position.set(0, 0.085, -0.02);
    const dome = new THREE.Mesh(D_DOME, this.domeMat); dome.position.set(0, 0.14, -0.05);
    const gimbal = new THREE.Mesh(D_GIMBAL, this.bodyMat); gimbal.position.set(0, -0.09, 0.16);
    const lens = new THREE.Mesh(D_LENS, this.lensMat); lens.rotation.x = Math.PI / 2; lens.position.set(0, -0.11, 0.22);
    drone.add(core, deck, dome, gimbal, lens);
    for (const ax of [-0.08, 0.08]) { const ant = new THREE.Mesh(D_ANT, this.bodyMat); ant.position.set(ax, 0.16, -0.18); drone.add(ant); }
    for (const sx of [-0.14, 0.14]) {
      const skid = new THREE.Mesh(D_SKID, this.bodyMat); skid.position.set(sx, -0.15, 0);
      const legF = new THREE.Mesh(D_SKIDLEG, this.bodyMat); legF.position.set(sx, -0.09, 0.14);
      const legB = new THREE.Mesh(D_SKIDLEG, this.bodyMat); legB.position.set(sx, -0.09, -0.14);
      drone.add(skid, legF, legB);
    }
    for (const aa of [Math.PI / 4, -Math.PI / 4]) { const arm = new THREE.Mesh(D_ARM, this.carbonMat); arm.rotation.y = aa; arm.castShadow = true; drone.add(arm); }
    const rotors: THREE.Mesh[] = [];
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2, ex = Math.cos(a) * 0.26, ez = Math.sin(a) * 0.26;
      const motor = new THREE.Mesh(D_MOTOR, this.bodyMat); motor.position.set(ex, 0.03, ez);
      const hub = new THREE.Mesh(D_HUB, this.bodyMat); hub.position.set(ex, 0.08, ez);
      const rotor = new THREE.Mesh(D_ROTOR, this.rotorMat); rotor.position.set(ex, 0.09, ez);
      const blade = new THREE.Mesh(D_BLADE, this.carbonMat); blade.position.set(ex, 0.092, ez); rotor.add(blade); // a visible blade under the disc blur
      const light = new THREE.Mesh(D_LIGHT, ez > 0 ? this.greenLight : this.redLight); light.position.set(ex, -0.02, ez);
      drone.add(motor, hub, rotor, light);
      rotors.push(rotor);
    }
    // per-instance class/team accent: a beacon atop the drone + a torso sash on the soldier, both sharing
    // ONE material per avatar so upsert() can recolour it (class = colour, team = emissive glow) cheaply.
    const tintMat = new THREE.MeshStandardMaterial({ color: 0x808080, emissive: 0x000000, roughness: 0.45, metalness: 0.2 });
    const beacon = new THREE.Mesh(D_BEACON, tintMat); beacon.position.set(0, 0.2, -0.02); drone.add(beacon);
    drone.frustumCulled = false;
    this.scene.add(drone);

    // --- Soldier: OUTER group at the eye (yaws only) → RIG (dropped so feet reach the ground) → static
    //     body + UPPER (head/arms/rifle, pitches) + LEG groups (hip-pivot, swung by the walk cycle) ---
    const human = new THREE.Group();
    human.rotation.order = "YXZ"; // yaw FIRST, then the stance lean → prone tips in the facing direction
    const rig = new THREE.Group(); rig.position.y = RIG_DROP; human.add(rig);

    // static body (torso/hips/vest/pack) — stays with the yawing body
    const hips = new THREE.Mesh(H_HIPS, this.fatigueMat); hips.position.set(0, -0.12, 0);
    const torso = new THREE.Mesh(H_TORSO, this.fatigueMat); torso.position.set(0, 0.18, 0); torso.castShadow = true;
    const vest = new THREE.Mesh(H_VEST, this.gearMat); vest.position.set(0, 0.16, 0.01);
    const pouchL = new THREE.Mesh(H_POUCH, this.gearMat); pouchL.position.set(-0.12, 0.02, 0.17);
    const pouchR = new THREE.Mesh(H_POUCH, this.gearMat); pouchR.position.set(0.12, 0.02, 0.17);
    const pack = new THREE.Mesh(H_PACK, this.gearMat); pack.position.set(0, 0.18, -0.19);
    const packTop = new THREE.Mesh(H_PACKTOP, this.gearMat); packTop.rotation.z = Math.PI / 2; packTop.position.set(0, 0.37, -0.19);
    rig.add(hips, torso, vest, pouchL, pouchR, pack, packTop);

    // UPPER: head + arms + rifle, pivoting at the neck/shoulder line (positions are relative to UPPER_PIVOT)
    const upper = new THREE.Group(); upper.position.y = UPPER_PIVOT;
    const neck = new THREE.Mesh(H_NECK, this.skinMat); neck.position.set(0, 0.04, 0);
    const head = new THREE.Mesh(H_HEAD, this.skinMat); head.position.set(0, 0.16, 0);
    const helmet = new THREE.Mesh(H_HELMET, this.gearMat); helmet.position.set(0, 0.18, 0);
    const visor = new THREE.Mesh(H_VISOR, this.visorMat); visor.position.set(0, 0.15, 0.1);
    const shL = new THREE.Mesh(H_SHOULDER, this.gearMat); shL.position.set(-0.26, -0.06, 0);
    const shR = new THREE.Mesh(H_SHOULDER, this.gearMat); shR.position.set(0.26, -0.06, 0);
    const uarmL = new THREE.Mesh(H_UARM, this.fatigueMat); uarmL.position.set(-0.27, -0.2, 0.02);
    const uarmR = new THREE.Mesh(H_UARM, this.fatigueMat); uarmR.position.set(0.27, -0.2, 0.02);
    const larmL = new THREE.Mesh(H_LARM, this.fatigueMat); larmL.rotation.x = -1.1; larmL.position.set(-0.2, -0.34, 0.18);
    const larmR = new THREE.Mesh(H_LARM, this.fatigueMat); larmR.rotation.x = -1.1; larmR.position.set(0.12, -0.34, 0.2);
    const gloveL = new THREE.Mesh(H_GLOVE, this.gunMat); gloveL.position.set(-0.2, -0.4, 0.3);
    const gloveR = new THREE.Mesh(H_GLOVE, this.gunMat); gloveR.position.set(0.12, -0.4, 0.32);
    const rifle = new THREE.Group();
    rifle.add(new THREE.Mesh(R_BODY, this.gunMat));
    const rbarrel = new THREE.Mesh(R_BARREL, this.gunMat); rbarrel.rotation.x = Math.PI / 2; rbarrel.position.set(0, 0.02, 0.34); rifle.add(rbarrel);
    const rmag = new THREE.Mesh(R_MAG, this.gunMat); rmag.position.set(0, -0.11, 0.02); rifle.add(rmag);
    const rstock = new THREE.Mesh(R_STOCK, this.gunMat); rstock.position.set(0, -0.01, -0.26); rifle.add(rstock);
    const rsight = new THREE.Mesh(R_SIGHT, this.gunMat); rsight.position.set(0, 0.07, 0.05); rifle.add(rsight);
    rifle.position.set(0.02, -0.39, 0.26);
    upper.add(neck, head, helmet, visor, shL, shR, uarmL, uarmR, larmL, larmR, gloveL, gloveR, rifle);
    rig.add(upper);

    // LEG groups pivoting at the hip (children are relative to the hip pivot) → swung by the walk cycle
    const makeLeg = (side: number): THREE.Group => {
      const leg = new THREE.Group(); leg.position.set(side * 0.1, HIP_PIVOT, 0);
      const thigh = new THREE.Mesh(H_THIGH, this.fatigueMat); thigh.position.set(0, -0.2, 0);
      const knee = new THREE.Mesh(H_KNEE, this.gearMat); knee.position.set(0, -0.36, 0.06);
      const shin = new THREE.Mesh(H_SHIN, this.fatigueMat); shin.position.set(0, -0.52, 0);
      const boot = new THREE.Mesh(H_BOOT, this.bootMat); boot.position.set(0, -0.7, 0.05);
      leg.add(thigh, knee, shin, boot);
      return leg;
    };
    const legL = makeLeg(-1), legR = makeLeg(1);
    rig.add(legL, legR);
    // sash on the OUTER human group (not the rig, which hides when the glTF model loads) → team band stays
    // visible at torso height whether the procedural rig or the rigged model is showing.
    const sash = new THREE.Mesh(H_BAND, tintMat); sash.position.set(0, RIG_DROP + 0.16, 0); human.add(sash);

    human.frustumCulled = false;
    human.visible = false;
    this.scene.add(human);

    const barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x000000, depthTest: false }));
    barBg.scale.set(0.62, 0.1, 1);
    const barFg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x35dd45, depthTest: false }));
    barFg.renderOrder = 999; barBg.renderOrder = 998;
    this.scene.add(barBg, barFg);

    // A kinematic collider (default groups) that follows this avatar each frame, so physics debris bounces
    // off it and the projectile/bullet raycasts (which include non-fixed bodies) stop on it instead of
    // passing straight through. Kinematic → it never gets pushed; the remote client already resolved its motion.
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
    this.physics.world.createCollider(RAPIER.ColliderDesc.ball(0.55).setFriction(0.4), body);

    const d: Remote = {
      drone, rotors, human, rig, upper, rifle, legL, legR, barBg, barFg,
      targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(),
      targetYaw: 0, targetPitch: 0, stance: 0, walkPhase: 0, prevX: 0, prevZ: 0, meleeTimer: 0,
      isHuman: false, team: 0, cls: "", tintMat, frac: 1, hp: MAX_HP, maxHp: MAX_HP, kills: 0, assists: 0, deaths: 0, lastSeen: performance.now(),
      model: null, modelReq: false, curClip: "none", body,
    };
    this.drones.set(id, d);
    return d;
  }
}
