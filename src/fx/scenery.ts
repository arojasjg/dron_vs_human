import * as THREE from "three";

// Purely-visual scene dressing: drifting cloud billboards. Not part of the voxel grid or physics, and
// NOT networked — so Math.random here is fine (it never affects the synced world or combat, like the
// audio RNG). Trees used to live here as cosmetic instances; they are now real DESTRUCTIBLE voxel trees
// built into the grid by prefabs.buildTree (part of the town), so only the clouds remain here.

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
    this.addClouds(scene);
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
