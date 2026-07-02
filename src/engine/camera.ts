import * as THREE from "three";
import type { Input } from "./input";

const SENS = 0.0022;
const BASE_SPEED = 7;
const BOOST = 3.2;

/** Free-fly camera with pointer-lock mouse look (WASD + Space/Ctrl, Shift to boost). */
export class FlyCamera {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private pitch = 0;
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.05, 500,
    );
    this.camera.position.set(9, 4.5, 12);
    this.yaw = Math.atan2(-this.camera.position.x, -this.camera.position.z);
    this.pitch = -0.15;
    this.lookFromAngles();
    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  /** Forward direction (normalized) — used to aim weapons. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  update(dt: number, input: Input): void {
    if (input.locked) {
      const d = input.consumeMouseDelta();
      this.yaw -= d.x * SENS;
      this.pitch -= d.y * SENS;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
      this.lookFromAngles();
    }

    let speed = BASE_SPEED;
    if (input.isDown("shiftleft") || input.isDown("shiftright")) speed *= BOOST;

    this.camera.getWorldDirection(this.dir);
    this.right.crossVectors(this.dir, this.up).normalize();

    const move = new THREE.Vector3();
    if (input.isDown("keyw")) move.add(this.dir);
    if (input.isDown("keys")) move.addScaledVector(this.dir, -1);
    if (input.isDown("keyd")) move.add(this.right);
    if (input.isDown("keya")) move.addScaledVector(this.right, -1);
    if (input.isDown("space")) move.y += 1;
    if (input.isDown("controlleft") || input.isDown("controlright")) move.y -= 1;

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      this.camera.position.add(move);
    }
  }

  private lookFromAngles(): void {
    const cp = Math.cos(this.pitch);
    const fwd = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );
    this.camera.lookAt(this.camera.position.clone().add(fwd));
  }
}
