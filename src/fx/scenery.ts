import * as THREE from "three";
import { VOXEL } from "../config";

// Purely-visual scene dressing: low-poly trees around the city + drifting cloud billboards. Not part of
// the voxel grid or physics, and NOT networked — so Math.random here is fine (it never affects the
// synced world or combat, like the audio RNG). Trees are placed along the STREET grid + city perimeter
// so they never clip through a building, and are drawn as TWO InstancedMeshes (trunks + leaves) so the
// whole forest costs 2 draw calls, not one per tree.

// city plot grid (mirrors prefabs PLOTS_X/Z, PLOT_W/D) in world metres
const PLOTS_X = 5, PLOTS_Z = 4, PLOT_W = 57 * VOXEL, PLOT_D = 54 * VOXEL;
const CITY_W = PLOTS_X * PLOT_W, CITY_D = PLOTS_Z * PLOT_D;

function cloudTexture(): THREE.Texture {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  for (let i = 0; i < 14; i++) {
    const x = 24 + Math.random() * 80, y = 44 + Math.random() * 44, r = 14 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Scenery {
  private readonly clouds: THREE.Sprite[] = [];
  private readonly cloudRange = 300;

  constructor(scene: THREE.Scene) {
    this.addTrees(scene);
    this.addClouds(scene);
  }

  private addTrees(scene: THREE.Scene): void {
    // collect tree spots along the street grid + a loose perimeter ring (never inside a plot)
    const spots: { x: number; z: number; yaw: number; s: number }[] = [];
    const put = (x: number, z: number) => spots.push({ x, z, yaw: Math.random() * Math.PI * 2, s: 0.85 + Math.random() * 0.5 });
    for (let px = 1; px < PLOTS_X; px++)
      for (let n = 0; n < 4; n++) put(px * PLOT_W + (Math.random() - 0.5) * 2, (0.15 + n * 0.25) * CITY_D + (Math.random() - 0.5) * 3);
    for (let pz = 1; pz < PLOTS_Z; pz++)
      for (let n = 0; n < 5; n++) put((0.12 + n * 0.2) * CITY_W + (Math.random() - 0.5) * 3, pz * PLOT_D + (Math.random() - 0.5) * 2);
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2, r = 0.62 * Math.max(CITY_W, CITY_D);
      put(CITY_W / 2 + Math.cos(a) * r + (Math.random() - 0.5) * 6, CITY_D / 2 + Math.sin(a) * r + (Math.random() - 0.5) * 6);
    }

    // two InstancedMeshes → the whole forest is 2 draw calls (trunks + leaves), 3 leaf blobs per tree
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 2.6, 6);
    const leafGeo = new THREE.IcosahedronGeometry(1.15, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x574433, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3c5626, roughness: 0.85 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length * 3);
    trunks.castShadow = true; leaves.castShadow = true;
    const d = new THREE.Object3D();
    let li = 0;
    spots.forEach((sp, i) => {
      d.position.set(sp.x, 1.3 * sp.s, sp.z); d.rotation.set(0, sp.yaw, 0); d.scale.setScalar(sp.s); d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
      for (let k = 0; k < 3; k++) {
        d.position.set(sp.x + (Math.random() - 0.5) * 0.9 * sp.s, (2.7 + Math.random() * 0.9) * sp.s, sp.z + (Math.random() - 0.5) * 0.9 * sp.s);
        d.rotation.set(0, sp.yaw, 0); d.scale.setScalar(sp.s * (0.75 + Math.random() * 0.6)); d.updateMatrix();
        leaves.setMatrixAt(li++, d.matrix);
      }
    });
    trunks.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true;
    trunks.computeBoundingSphere(); leaves.computeBoundingSphere();
    scene.add(trunks, leaves);
  }

  private addClouds(scene: THREE.Scene): void {
    const tex = cloudTexture();
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55 + Math.random() * 0.25, depthWrite: false, fog: false }));
      const sc = 45 + Math.random() * 75; s.scale.set(sc, sc * 0.5, 1);
      s.position.set((Math.random() - 0.5) * this.cloudRange * 2, 78 + Math.random() * 46, (Math.random() - 0.5) * this.cloudRange * 2);
      scene.add(s); this.clouds.push(s);
    }
  }

  /** Drift the clouds slowly across the sky (wraps around). */
  update(dt: number): void {
    for (const s of this.clouds) {
      s.position.x += dt * 1.4;
      if (s.position.x > this.cloudRange) s.position.x -= this.cloudRange * 2;
    }
  }
}
