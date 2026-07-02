import * as THREE from "three";
import type { Role } from "./roles";

export const MAX_HP = 100;

interface Remote {
  drone: THREE.Group;  // quadcopter avatar (role "drone")
  human: THREE.Group;  // walking-figure avatar (role "human")
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
  lastSeen: number;
}

// Big military quadcopter (~0.9 m span): a chunky hull, a sensor dome, a red nose, and 4 booms
// ending in motors + wide rotor discs.
const D_HULL = new THREE.BoxGeometry(0.5, 0.16, 0.5);
const D_DOME = new THREE.SphereGeometry(0.15, 12, 8);
const D_NOSE = new THREE.ConeGeometry(0.09, 0.24, 10);
const D_BOOM = new THREE.BoxGeometry(0.66, 0.05, 0.09);
const D_MOTOR = new THREE.CylinderGeometry(0.07, 0.08, 0.1, 10);
const D_ROTOR = new THREE.CylinderGeometry(0.24, 0.24, 0.02, 18);
// Soldier (~1.7 m, centred at the capsule origin): vest torso, helmeted head, arms, legs, backpack.
const H_TORSO = new THREE.BoxGeometry(0.5, 0.62, 0.3);
const H_HEAD = new THREE.SphereGeometry(0.14, 10, 8);
const H_HELMET = new THREE.SphereGeometry(0.185, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2);
const H_ARM = new THREE.BoxGeometry(0.14, 0.56, 0.14);
const H_LEG = new THREE.BoxGeometry(0.17, 0.72, 0.17);
const H_PACK = new THREE.BoxGeometry(0.34, 0.42, 0.16);

/** Renders the other players: a quadcopter for drones and a figure for humans, each with a
 *  billboarded health bar. The avatar shown follows each peer's broadcast role. */
export class RemoteDrones {
  private readonly drones = new Map<number, Remote>();
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.55, metalness: 0.7 }); // gunmetal
  private readonly domeMat = new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.3, metalness: 0.4 });
  private readonly rotorMat = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.8 });
  private readonly noseMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0x661008, roughness: 0.4 });
  private readonly fatigueMat = new THREE.MeshStandardMaterial({ color: 0x4a5238, roughness: 0.85 }); // olive fatigues
  private readonly gearMat = new THREE.MeshStandardMaterial({ color: 0x30352a, roughness: 0.8 });     // vest/helmet/pack
  private readonly skinMat = new THREE.MeshStandardMaterial({ color: 0x8a6b50, roughness: 0.8 });

  constructor(private readonly scene: THREE.Scene) {}

  get count(): number { return this.drones.size; }

  /** First remote's position (test helper). */
  firstPos(): { x: number; y: number; z: number } | null {
    for (const d of this.drones.values()) return { x: d.drone.position.x, y: d.drone.position.y, z: d.drone.position.z };
    return null;
  }

  upsert(id: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hp: number, role: Role = "drone", maxHp = MAX_HP): void {
    let d = this.drones.get(id);
    if (!d) d = this.create(id);
    const isHuman = role === "human";
    d.drone.visible = !isHuman;
    d.human.visible = isHuman;
    for (const g of [d.drone, d.human]) { g.position.set(x, y, z); g.quaternion.set(qx, qy, qz, qw); }

    const frac = Math.max(0, Math.min(1, hp / maxHp));
    const barY = isHuman ? 1.05 : 0.45;
    d.barFg.scale.set(0.6 * frac, 0.08, 1);
    d.barFg.position.set(x - 0.3 * (1 - frac), y + barY, z);
    d.barBg.position.set(x, y + barY, z);
    (d.barFg.material as THREE.SpriteMaterial).color.setHex(frac > 0.5 ? 0x35dd45 : frac > 0.25 ? 0xddc233 : 0xdd3a30);
    d.lastSeen = performance.now();
  }

  /** Drops peers we haven't heard from recently (disconnects). */
  prune(): void {
    const now = performance.now();
    for (const [id, d] of this.drones) if (now - d.lastSeen > 4000) this.remove(id);
  }

  remove(id: number): void {
    const d = this.drones.get(id);
    if (!d) return;
    this.scene.remove(d.drone, d.human, d.barBg, d.barFg);
    this.drones.delete(id);
  }

  private create(id: number): Remote {
    const drone = new THREE.Group();
    const hull = new THREE.Mesh(D_HULL, this.bodyMat); hull.castShadow = true;
    const dome = new THREE.Mesh(D_DOME, this.domeMat); dome.position.set(0, 0.11, 0); dome.scale.set(1, 0.7, 1);
    const nose = new THREE.Mesh(D_NOSE, this.noseMat); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0, -0.32);
    drone.add(hull, dome, nose);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const boom = new THREE.Mesh(D_BOOM, this.bodyMat); boom.rotation.y = a; boom.castShadow = true;
      const ex = Math.cos(a) * 0.33, ez = Math.sin(a) * 0.33;
      const motor = new THREE.Mesh(D_MOTOR, this.domeMat); motor.position.set(ex, 0.05, ez);
      const rotor = new THREE.Mesh(D_ROTOR, this.rotorMat); rotor.position.set(ex, 0.11, ez);
      drone.add(boom, motor, rotor);
    }
    drone.frustumCulled = false;
    this.scene.add(drone);

    const human = new THREE.Group();
    const torso = new THREE.Mesh(H_TORSO, this.gearMat); torso.position.set(0, 0.05, 0); torso.castShadow = true; // vest
    const head = new THREE.Mesh(H_HEAD, this.skinMat); head.position.set(0, 0.48, 0);
    const helmet = new THREE.Mesh(H_HELMET, this.gearMat); helmet.position.set(0, 0.5, 0);
    const pack = new THREE.Mesh(H_PACK, this.gearMat); pack.position.set(0, 0.08, 0.2);
    const armL = new THREE.Mesh(H_ARM, this.fatigueMat); armL.position.set(-0.32, 0.05, 0);
    const armR = new THREE.Mesh(H_ARM, this.fatigueMat); armR.position.set(0.32, 0.05, 0);
    const legL = new THREE.Mesh(H_LEG, this.fatigueMat); legL.position.set(-0.11, -0.58, 0);
    const legR = new THREE.Mesh(H_LEG, this.fatigueMat); legR.position.set(0.11, -0.58, 0);
    human.add(torso, head, helmet, pack, armL, armR, legL, legR);
    human.frustumCulled = false;
    human.visible = false;
    this.scene.add(human);

    const barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x000000, depthTest: false }));
    barBg.scale.set(0.62, 0.1, 1);
    const barFg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x35dd45, depthTest: false }));
    barFg.renderOrder = 999; barBg.renderOrder = 998;
    this.scene.add(barBg, barFg);

    const d: Remote = { drone, human, barBg, barFg, lastSeen: performance.now() };
    this.drones.set(id, d);
    return d;
  }
}
