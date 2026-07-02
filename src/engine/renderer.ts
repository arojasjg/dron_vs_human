import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { QualityConfig } from "./quality";

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight;
  private readonly envTex: THREE.Texture;

  constructor(container: HTMLElement) {
    // MSAA is a creation-time flag → decided from the saved preset (Bajo turns it off). Runtime
    // preset changes toggle IBL/shadows/pixelRatio live; AA only follows on the next reload.
    const savedQ = typeof localStorage !== "undefined" ? localStorage.getItem("quality") : null;
    this.renderer = new THREE.WebGLRenderer({ antialias: savedQ !== "bajo", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated (auto-downgrades anyway)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // sky gradient backdrop + fog for depth
    this.scene.background = makeSky();
    this.scene.fog = new THREE.Fog(0xaec6da, 60, 240);

    // image-based lighting for believable reflections (esp. on metal/glass)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;

    // sun — a TIGHT shadow frustum that Game keeps centred on the player each frame, so only nearby
    // chunks are shadow-casters (distant buildings, faded by fog anyway, cost nothing). This is what
    // lets the city grow without the shadow pass redrawing every building.
    this.sun = new THREE.DirectionalLight(0xfff2d8, 3.0);
    this.sun.position.set(28, 44, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 120;
    const s = 40;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x55504a, 0.55));
    window.addEventListener("resize", () => this.onResize());
  }

  private shadowSize = 2048;

  /** Resizes the shadow map (cost ∝ area). Realloc happens on the next frame. */
  setShadowMapSize(n: number): void {
    if (n === this.shadowSize) return;
    this.shadowSize = n;
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } // realloc next frame
  }

  /** Applies a graphics-quality preset live: image-based reflections, shadow map, render resolution. */
  applyQuality(cfg: QualityConfig): void {
    this.scene.environment = cfg.ibl ? this.envTex : null;
    this.renderer.shadowMap.enabled = cfg.shadow > 0;
    if (cfg.shadow > 0) this.setShadowMapSize(cfg.shadow);
    this.renderer.setPixelRatio(cfg.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Keeps the tight shadow frustum over the player so shadows stay crisp near the camera. */
  followSun(x: number, y: number, z: number): void {
    this.sun.position.set(x + 18, y + 42, z + 14);
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }
}

function makeSky(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, "#6aa0d8");
  g.addColorStop(0.55, "#a9c8e6");
  g.addColorStop(1.0, "#dfeaf2");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
