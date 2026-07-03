import * as THREE from "three";
import type { Role } from "./roles";
import { legSwing, stanceInfo, type Stance } from "./humanPose";

export const MAX_HP = 100;

interface Remote {
  drone: THREE.Group;  // quadcopter avatar (role "drone"), positioned at the eye
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
  frac: number;                // hp fraction for the health bar
  hp: number;                  // raw hp/maxHp — for the teammates panel
  maxHp: number;
  lastSeen: number;
}

const LERP = 18;               // interpolation rate → smooths the ~20 Hz network samples into 60 fps motion
const SNAP_DIST = 6;           // metres: a jump farther than this is a teleport/respawn → snap, don't slide
const RIG_DROP = -0.55;        // the model hangs this far below the eye so the feet reach the ground
const UPPER_PIVOT = 0.42;      // neck/shoulder height the head+arms pitch about
const HIP_PIVOT = -0.2;        // hip height the legs swing about
const WALK_FREQ = 1.7;         // walk-phase advance per metre travelled
const HUMAN_RUN = 7.5;         // matches Walker RUN — scales the leg swing amplitude

// --- Drone: detailed military quadcopter (~0.95 m span) ---
const D_CORE = new THREE.BoxGeometry(0.34, 0.12, 0.52);          // fuselage
const D_DECK = new THREE.BoxGeometry(0.26, 0.07, 0.34);          // raised avionics deck
const D_GIMBAL = new THREE.SphereGeometry(0.085, 14, 10);        // camera ball underneath
const D_LENS = new THREE.CylinderGeometry(0.045, 0.055, 0.05, 12);
const D_DOME = new THREE.SphereGeometry(0.1, 14, 8);             // top sensor dome
const D_ARM = new THREE.BoxGeometry(0.52, 0.035, 0.06);          // boom
const D_MOTOR = new THREE.CylinderGeometry(0.05, 0.06, 0.09, 12);
const D_ROTOR = new THREE.CylinderGeometry(0.2, 0.2, 0.012, 20); // rotor disc
const D_HUB = new THREE.CylinderGeometry(0.028, 0.028, 0.05, 8);
const D_SKID = new THREE.BoxGeometry(0.028, 0.028, 0.4);         // landing skid rail
const D_SKIDLEG = new THREE.BoxGeometry(0.025, 0.12, 0.025);
const D_LIGHT = new THREE.SphereGeometry(0.022, 8, 6);           // nav light
const D_ANT = new THREE.CylinderGeometry(0.006, 0.006, 0.17, 6); // antenna

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
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.75 }); // gunmetal
  private readonly carbonMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.35, metalness: 0.6 }); // carbon fibre
  private readonly domeMat = new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.2, metalness: 0.5 });
  private readonly lensMat = new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.1, metalness: 0.2, emissive: 0x220033 });
  private readonly rotorMat = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.8, transparent: true, opacity: 0.55 });
  private readonly redLight = new THREE.MeshStandardMaterial({ color: 0xff2a1e, emissive: 0xcc1408, roughness: 0.4 });
  private readonly greenLight = new THREE.MeshStandardMaterial({ color: 0x2bff44, emissive: 0x10bb22, roughness: 0.4 });
  private readonly fatigueMat = new THREE.MeshStandardMaterial({ color: 0x4a5238, roughness: 0.9 }); // olive fatigues
  private readonly gearMat = new THREE.MeshStandardMaterial({ color: 0x2b3024, roughness: 0.85 });   // vest/helmet/pack
  private readonly skinMat = new THREE.MeshStandardMaterial({ color: 0x8a6b50, roughness: 0.8 });
  private readonly gunMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.5, metalness: 0.6 });
  private readonly visorMat = new THREE.MeshStandardMaterial({ color: 0x121a22, roughness: 0.15, metalness: 0.3, emissive: 0x08222a });
  private readonly bootMat = new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.9 });

  constructor(private readonly scene: THREE.Scene) {}

  get count(): number { return this.drones.size; }

  /** First remote's position (test helper). */
  firstPos(): { x: number; y: number; z: number } | null {
    for (const d of this.drones.values()) return { x: d.drone.position.x, y: d.drone.position.y, z: d.drone.position.z };
    return null;
  }

  /** Triggers a rifle-butt swing animation on a peer's avatar (they just melee'd). */
  meleeAnim(id: number): void { const d = this.drones.get(id); if (d) d.meleeTimer = 0.4; }

  /** Snapshot of every known peer (id, hp, role) — the HUD filters to teammates by role. */
  peers(): { id: number; hp: number; maxHp: number; isHuman: boolean }[] {
    const out: { id: number; hp: number; maxHp: number; isHuman: boolean }[] = [];
    for (const [id, d] of this.drones) out.push({ id, hp: d.hp, maxHp: d.maxHp, isHuman: d.isHuman });
    return out;
  }

  upsert(id: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hp: number, role: Role = "drone", maxHp = MAX_HP, yaw = 0, pitch = 0, stance: Stance = 0): void {
    let d = this.drones.get(id);
    const isNew = !d;
    if (!d) d = this.create(id);
    d.targetPos.set(x, y, z);              // store the target; the avatar EASES toward it in update()
    d.targetQuat.set(qx, qy, qz, qw);
    d.targetYaw = yaw; d.targetPitch = pitch; d.stance = stance;
    d.isHuman = role === "human";
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
  update(dt: number): void {
    const k = 1 - Math.exp(-LERP * dt);
    for (const d of this.drones.values()) {
      // a normal step between 20 Hz samples is < ~1 m; a jump this big is a respawn/teleport → snap it.
      const f = d.drone.position.distanceToSquared(d.targetPos) > SNAP_DIST * SNAP_DIST ? 1 : k;
      // DRONE: full orientation (it banks/rolls) straight from the camera quaternion.
      d.drone.position.lerp(d.targetPos, f); d.drone.quaternion.slerp(d.targetQuat, f);
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
      // melee: a quick rifle-butt jab arc, then rest
      if (d.meleeTimer > 0) {
        d.meleeTimer = Math.max(0, d.meleeTimer - dt);
        d.rifle.rotation.x = -Math.sin((1 - d.meleeTimer / 0.4) * Math.PI) * 1.5;
      } else if (d.rifle.rotation.x !== 0) {
        d.rifle.rotation.x = 0;
      }
      // health bar above whichever avatar is shown
      const p = d.isHuman ? h.position : d.drone.position;
      d.barFg.scale.set(0.6 * d.frac, 0.08, 1);
      d.barFg.position.set(p.x - 0.3 * (1 - d.frac), p.y + 0.45, p.z);
      d.barBg.position.set(p.x, p.y + 0.45, p.z);
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
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2, ex = Math.cos(a) * 0.26, ez = Math.sin(a) * 0.26;
      const motor = new THREE.Mesh(D_MOTOR, this.bodyMat); motor.position.set(ex, 0.03, ez);
      const hub = new THREE.Mesh(D_HUB, this.bodyMat); hub.position.set(ex, 0.08, ez);
      const rotor = new THREE.Mesh(D_ROTOR, this.rotorMat); rotor.position.set(ex, 0.09, ez);
      const light = new THREE.Mesh(D_LIGHT, ez > 0 ? this.greenLight : this.redLight); light.position.set(ex, -0.02, ez);
      drone.add(motor, hub, rotor, light);
    }
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

    human.frustumCulled = false;
    human.visible = false;
    this.scene.add(human);

    const barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x000000, depthTest: false }));
    barBg.scale.set(0.62, 0.1, 1);
    const barFg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x35dd45, depthTest: false }));
    barFg.renderOrder = 999; barBg.renderOrder = 998;
    this.scene.add(barBg, barFg);

    const d: Remote = {
      drone, human, rig, upper, rifle, legL, legR, barBg, barFg,
      targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(),
      targetYaw: 0, targetPitch: 0, stance: 0, walkPhase: 0, prevX: 0, prevZ: 0, meleeTimer: 0,
      isHuman: false, frac: 1, hp: MAX_HP, maxHp: MAX_HP, lastSeen: performance.now(),
    };
    this.drones.set(id, d);
    return d;
  }
}
