import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RENDER_DIST } from "../config";
import type { QualityConfig } from "./quality";

// Scope-circle radius in screen-HEIGHT units (0.6 ≈ 30vh radius / 60vh across, matched to the HUD ring/mask).
// Because the magnified scene is squeezed into a circle SCOPE_CIRCLE_R× the screen height, the achieved
// magnification is mainFOV·SCOPE_CIRCLE_R / scopeFOV — so a ×N zoom needs scopeFOV = mainFOV·SCOPE_CIRCLE_R / N.
// (Grow this AND the HUD's #hud-scope mask + #hud-scope-ring vh values together, or they desync.)
export const SCOPE_CIRCLE_R = 0.6;

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
    this.scene.fog = new THREE.Fog(SKY.horizon, 45, RENDER_DIST - 12);

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

  // ALTO-only bloom post-processing. Built LAZILY the first time bloom turns on, so medio/bajo (and any
  // machine that never reaches ALTO) allocate none of its render targets. When off, render() takes the
  // direct path and the composer costs nothing.
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomOn = false;

  /** Dynamic-resolution multiplier on top of the preset pixel ratio — the fill-rate lever that keeps a
   *  weak GPU at 60 fps. A change reallocs the drawing buffer, so the caller debounces it. */
  setRenderScale(scale: number): void {
    if (scale === this.dynScale) return;
    this.dynScale = scale;
    this.renderer.setPixelRatio(this.baseRatio * scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.syncComposerSize();
  }

  /** Enables the ALTO-only bloom pass (bright emissives, explosions, muzzle, sun). Off → render() uses the
   *  direct path so medio/bajo pay nothing. Lazily builds the composer the first time it's switched on. */
  setBloom(on: boolean): void {
    this.bloomOn = on;
  }

  /** Live view-distance change (settings menu): slide the fog so the mesh distance-cull edge (game.ts, at the
   *  same radius) stays hidden — near/far scale with the radius so the haze ramp looks the same at any range. */
  setViewDistance(d: number): void {
    const fog = this.scene.fog as THREE.Fog;
    if (!fog) return;
    fog.near = Math.round(d * 0.45);
    fog.far = d - 12;
  }

  private syncComposerSize(): void {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.baseRatio * this.dynScale);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  private ensureComposer(camera: THREE.Camera): void {
    if (this.composer) { this.renderPass!.camera = camera; return; }
    const composer = new EffectComposer(this.renderer); // HalfFloat targets by default → bloom sees HDR values
    const rp = new RenderPass(this.scene, camera);
    // strength, radius, THRESHOLD — a high threshold keeps the glow off ordinary surfaces and lets only the
    // bright things (explosion/muzzle particles, hot emissives, the sun-lit sky) bloom. Tunable by eye.
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.45, 0.82);
    composer.addPass(rp);
    composer.addPass(bloom);
    composer.addPass(new OutputPass()); // final tone-map (ACES) + sRGB; the RenderPass/bloom chain works in linear
    this.composer = composer;
    this.renderPass = rp;
    this.syncComposerSize();
  }

  /** Resizes the shadow map (cost ∝ area). Realloc happens on the next frame. */
  setShadowMapSize(n: number): void {
    if (n === this.shadowSize) return;
    this.shadowSize = n;
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } // realloc next frame
  }

  /** Applies a graphics-quality preset live: shadow map, render resolution, ALTO-only bloom. */
  applyQuality(cfg: QualityConfig): void {
    this.renderer.shadowMap.enabled = cfg.shadow > 0;
    if (cfg.shadow > 0) this.setShadowMapSize(cfg.shadow);
    this.baseRatio = cfg.pixelRatio;
    this.renderer.setPixelRatio(this.baseRatio * this.dynScale); // keep any active dynamic-res scale
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.setBloom(cfg.bloom);
    this.syncComposerSize();
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
    this.syncComposerSize();
  }

  render(camera: THREE.Camera): void {
    if (this.bloomOn) {
      this.ensureComposer(camera); // builds on first use; refreshes the pass camera thereafter
      this.composer!.render();
    } else {
      this.renderer.render(this.scene, camera);
    }
  }

  // --- optical sniper scope (built lazily on first use) -------------------------------------------------
  private scopeRT: THREE.WebGLRenderTarget | null = null;
  private scopeCam: THREE.PerspectiveCamera | null = null;
  private scopeOverlay: THREE.Scene | null = null;
  private scopeQuadCam: THREE.OrthographicCamera | null = null;
  private scopeCircle: THREE.Mesh | null = null;

  /** Draws the sniper scope: renders the scene ONCE MORE through a narrow-FOV camera co-located with the
   *  player's view (into a small square RT), then composites that RT onto the frame as a centred circle. So
   *  the MAGNIFICATION lives only inside the scope glass — the main frame (periphery) stays 1×. Call AFTER
   *  render(). `zoomFov` is the scope FOV (lower = more zoom); `radius` is the circle radius in screen-height
   *  units (0.44 ≈ 22vh, matched to the HUD scope ring). The narrow frustum sees few objects → cheap. */
  renderScope(camera: THREE.PerspectiveCamera, zoomFov: number, radius = SCOPE_CIRCLE_R): void {
    if (!this.scopeRT) {
      this.scopeRT = new THREE.WebGLRenderTarget(512, 512);
      this.scopeRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.scopeCam = new THREE.PerspectiveCamera(zoomFov, 1, camera.near, camera.far);
      this.scopeOverlay = new THREE.Scene();
      this.scopeQuadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
      this.scopeQuadCam.position.z = 1;
      this.scopeCircle = new THREE.Mesh(
        new THREE.CircleGeometry(1, 64),
        new THREE.MeshBasicMaterial({ map: this.scopeRT.texture, toneMapped: false }),
      );
      this.scopeOverlay.add(this.scopeCircle);
    }
    const sc = this.scopeCam!;
    camera.getWorldPosition(sc.position);
    camera.getWorldQuaternion(sc.quaternion);
    sc.fov = zoomFov; sc.near = camera.near; sc.far = camera.far; sc.updateProjectionMatrix();
    this.renderer.setRenderTarget(this.scopeRT);
    this.renderer.render(this.scene, sc);
    this.renderer.setRenderTarget(null);
    const aspect = window.innerWidth / window.innerHeight;
    const q = this.scopeQuadCam!;
    q.left = -aspect; q.right = aspect; q.updateProjectionMatrix();
    this.scopeCircle!.scale.setScalar(radius);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.scopeOverlay!, q);
    this.renderer.autoClear = true;
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
  g.addColorStop(0.0, "#2b5fb0");        // deeper, richer blue overhead
  g.addColorStop(0.35, hex(SKY.zenith));
  g.addColorStop(0.62, "#8fbadf");
  g.addColorStop(0.86, "#c3d2dc");
  g.addColorStop(1.0, hex(SKY.horizon)); // meets the fog colour at the horizon
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 512);
  // a broad, warm sun-glow band swelling into the horizon (a golden-hour cue that adds depth to the backdrop)
  const glow = ctx.createLinearGradient(0, 250, 0, 500);
  glow.addColorStop(0, "rgba(255,241,220,0)");
  glow.addColorStop(0.7, "rgba(255,236,198,0.28)");
  glow.addColorStop(1.0, "rgba(255,224,175,0.5)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 250, 2, 250);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
