import * as THREE from "three";
import { VOXEL } from "../config";
import { instanceModel } from "../engine/modelLoader";
import type { ObjSite } from "../build/prefabs";

// Decorative HQ model marking each team's base. Render-ONLY: the destructible voxel objective core is untouched
// (so grid/determinism/sync are byte-identical), the barracks just sits over it as a landmark, tinted to its
// side (drone = red, human = cyan). One shared glTF, cloned per site (≤4 sites → cheap). A load failure just
// leaves the base unmarked (the voxel objective still works).

const HQ_URL = "models/bases/barracks.glb";
const SIDE_TINT: Record<"drone" | "human", number> = { drone: 0xff5236, human: 0x38e6ff };
const HQ_HEIGHT = 5; // metres — the model is normalized to this so the barracks reads as a base-sized structure

export class BaseModels {
  private readonly group = new THREE.Group();
  private token = 0;
  private warm?: () => void; // background shader prewarm, fired after each HQ model mounts

  constructor(private readonly scene: THREE.Scene) { this.scene.add(this.group); }

  /** Hook called after each HQ glTF mounts, so the game can prewarm its shaders off the first render. */
  setWarm(fn: () => void): void { this.warm = fn; }

  /** (Re)place an HQ over every objective site. Called on each dvh world build. Empty/non-dvh → clears them. */
  build(sites: readonly ObjSite[]): void {
    const token = ++this.token; // guards the async load against a world rebuild mid-stream
    this.clear();
    for (const s of sites) {
      const cx = ((s.x0 + s.x1 + 1) / 2) * VOXEL, cz = ((s.z0 + s.z1 + 1) / 2) * VOXEL, gy = s.y0 * VOXEL;
      void instanceModel(HQ_URL).then((m) => {
        if (!m || token !== this.token) { if (m) this.dispose(m.scene); return; } // failed / rebuilt → drop
        const model = m.scene;
        // normalize to a base-sized structure sitting on the ground at the site centre
        const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
        const scale = HQ_HEIGHT / Math.max(0.001, size.y);
        model.scale.setScalar(scale);
        const c = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
        model.position.set(cx - c.x, gy - box.min.y * scale, cz - c.z); // base on the ground, centred in XZ
        const tint = SIDE_TINT[s.team];
        for (const mat of m.materials) { mat.emissive.setHex(tint); mat.emissiveIntensity = 0.4; } // team accent glow
        model.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { me.castShadow = true; me.receiveShadow = true; } });
        this.group.add(model);
        this.warm?.(); // background-compile its shaders before its first render
      });
    }
  }

  private clear(): void {
    for (const c of [...this.group.children]) { this.group.remove(c); this.dispose(c); }
  }

  private dispose(o: THREE.Object3D): void {
    o.traverse((n) => { // glTF geometry is SHARED across instances → dispose only this clone's materials
      const me = n as THREE.Mesh; if (!me.isMesh) return;
      const mt = me.material;
      if (Array.isArray(mt)) mt.forEach((x) => x.dispose()); else if (mt) mt.dispose();
    });
  }
}
