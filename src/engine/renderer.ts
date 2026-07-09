import * as THREE from "three";
import { RENDER_DIST } from "../config";
import type { QualityConfig } from "./quality";

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight;

  constructor(container: HTMLElement) {
    // MSAA is a creation-time flag → decided from the saved preset (Bajo turns it off). Runtime
    // preset changes toggle shadows/pixelRatio live; AA only follows on the next reload.
    const savedQ = typeof localStorage !== "undefined" ? localStorage.getItem("quality") : null;
    this.renderer = new THREE.WebGLRenderer({ antialias: savedQ !== "bajo", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.info.autoReset = false; // Game resets once per frame so render.calls includes the shadow + GPGPU passes
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false; // Game refreshes on demand (~30Hz) via refreshShadows() → ~half the pass
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated (auto-downgrades anyway)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // sky gradient backdrop + fog for depth. Fog color == the sky HORIZON so buildings dissolve INTO the
    // sky, not into a mismatched grey — a big "outdoor" cue at almost no cost.
    this.scene.background = makeSky();
    // Fog reaches FULL opacity a touch before the RENDER_DIST cull (config.ts), so chunks are already
    // dissolved into the sky by the time they're distance-culled → the cut is invisible. Matching the fog to
    // the cull radius is what makes the culling free of pop.
    this.scene.fog = new THREE.Fog(SKY.horizon, 55, RENDER_DIST - 15);

    // No image-based lighting (IBL/PMREM): on the target GPUs, sampling the sky cubemap per PBR pixel was
    // the single dominant cost — it capped the frame to ~50fps even inside a 4-wall room, while dropping it
    // holds 60-85fps with shadows + detail intact. Ambient now comes from the hemisphere + fill lights below,
    // which read as the same coherent outdoor light without the per-pixel reflection tax.

    // sun — a TIGHT shadow frustum that Game keeps centred on the player each frame, so only nearby
    // chunks are shadow-casters (distant buildings, faded by fog anyway, cost nothing). This is what
    // lets the city grow without the shadow pass redrawing every building.
    this.sun = new THREE.DirectionalLight(0xfff0d4, 3.5);
    this.sun.position.set(28, 44, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 110;
    // Tighter shadow box (~70 m, matched to fog-near) → far fewer chunk meshes are shadow-casters, so the
    // shadow pass submits far fewer draw calls (its cost is CPU submit, not map resolution). Distant shadows
    // are lost, but they dissolve into fog at ~70 m anyway, so there's no visible shadowless band.
    const s = 35;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(new THREE.HemisphereLight(0xaccbee, 0x4a4640, 0.75)); // richer sky/ground fill
    // a dim COOL fill from the opposite side of the sun softens the shadow side (no shadow → cheap)
    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.55);
    fill.position.set(-24, 22, -18);
    this.scene.add(fill);
    window.addEventListener("resize", () => this.onResize());
  }

  private shadowSize = 2048;
  private baseRatio = 1;   // the active preset's pixel ratio
  private dynScale = 1;    // fps-driven dynamic-resolution multiplier on top of it (dynamicRes.ts)

  /** Dynamic-resolution multiplier on top of the preset pixel ratio — the fill-rate lever that keeps a
   *  weak GPU at 60 fps. A change reallocs the drawing buffer, so the caller debounces it. */
  setRenderScale(scale: number): void {
    if (scale === this.dynScale) return;
    this.dynScale = scale;
    this.renderer.setPixelRatio(this.baseRatio * scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Resizes the shadow map (cost ∝ area). Realloc happens on the next frame. */
  setShadowMapSize(n: number): void {
    if (n === this.shadowSize) return;
    this.shadowSize = n;
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } // realloc next frame
  }

  /** Applies a graphics-quality preset live: shadow map, render resolution. */
  applyQuality(cfg: QualityConfig): void {
    this.renderer.shadowMap.enabled = cfg.shadow > 0;
    if (cfg.shadow > 0) this.setShadowMapSize(cfg.shadow);
    this.baseRatio = cfg.pixelRatio;
    this.renderer.setPixelRatio(this.baseRatio * this.dynScale); // keep any active dynamic-res scale
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Requests one shadow-map re-render on the next render() (autoUpdate is off). Call together with
   *  followSun so the sun frustum and the shadow map move as one — a stale map stays world-anchored. */
  refreshShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
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

// Shared sky palette — the SAME colours drive the background and the fog, so the whole scene reads as one
// coherent outdoor lighting environment (sky backdrop dissolving into matched fog at the horizon).
const SKY = {
  zenith: 0x3d74c4,   // deep sky overhead
  horizon: 0xd3dae0,  // pale haze at the horizon (== fog colour)
  ground: 0x585349,   // warm ground bounce below the horizon
  sun: 0xfff1dc,      // warm sun disc/glow
};

function makeSky(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.0, hex(SKY.zenith));
  g.addColorStop(0.55, "#8fbadf");
  g.addColorStop(0.82, "#c3d2dc");
  g.addColorStop(1.0, hex(SKY.horizon)); // meets the fog colour at the horizon
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 512);
  // a soft warm glow band near the horizon on the sun side (adds depth to the backdrop)
  const glow = ctx.createLinearGradient(0, 300, 0, 470);
  glow.addColorStop(0, "rgba(255,241,220,0)");
  glow.addColorStop(1, "rgba(255,238,205,0.35)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 300, 2, 170);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
