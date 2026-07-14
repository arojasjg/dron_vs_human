import * as THREE from "three";
import { buildClassModel } from "../net/classModels";
import { classStats, type Role } from "../net/roles";
import { instanceModel, pickAction, type ModelInstance } from "../engine/modelLoader";
import { MODEL_CONFIGS } from "../net/avatarModels";

// Self-contained 3D class preview for the lobby. Owns its OWN tiny renderer/scene/camera + rAF loop on a
// dedicated <canvas>, fully decoupled from the game renderer. Created when the lobby opens and disposed
// (forceContextLoss) when the match starts → only ONE WebGL context is live during play. The model spins
// on a turntable and can be dragged to rotate. Transparent background so the lobby card shows through.

export class ClassPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pivot = new THREE.Group();      // holds the model; rotated for the turntable
  private model: THREE.Group | null = null;        // the currently-shown group (procedural fallback OR glTF scene)
  private mi: ModelInstance | null = null;         // set when the glTF is showing (owns the mixer + per-instance mats)
  private loadToken = 0;                            // guards against a stale async glTF load after the class changed
  private raf = 0;
  private lastT = 0;
  private yaw = 0.6;
  private dragging = false;
  private lastX = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0); // transparent → the tactical card shows behind the model
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.set(0, 0.15, 3.4);

    const hemi = new THREE.HemisphereLight(0xbfe8ff, 0x0a1410, 1.15); this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(2.2, 3.5, 2.5); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6bff9e, 0.7); rim.position.set(-2.5, 1.2, -2); this.scene.add(rim); // phosphor rim to match the HUD
    this.scene.add(this.pivot);

    this.onDown = this.onDown.bind(this); this.onMove = this.onMove.bind(this); this.onUp = this.onUp.bind(this);
    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.resize();
    this.loop(0);
  }

  /** Show the class: the procedural model IMMEDIATELY (so there's always something), then swap in the real glTF
   *  (Soldier / RobotExpressive) once it streams in — tinted to the class colour. Procedural stays as the fallback
   *  if the glTF fails. Guards a stale load if the class changes mid-stream. */
  setClass(role: Role, cls: string): void {
    if (this.disposed) return;
    const token = ++this.loadToken;
    this.showGroup(buildClassModel(role, cls), false); // instant procedural placeholder/fallback
    const cfg = MODEL_CONFIGS[role === "drone" ? "robot" : "soldier"];
    instanceModel(cfg.url).then((m) => {
      if (this.disposed || token !== this.loadToken || !m) { // disposed / class changed / load failed → keep procedural
        if (m) { m.mixer.stopAllAction(); m.scene.traverse((o) => { const me = o as THREE.Mesh; if (!me.isMesh) return; const mt = me.material; if (Array.isArray(mt)) mt.forEach((x) => x.dispose()); else if (mt) mt.dispose(); }); } // free the stale instance's per-instance materials (NOT the shared geometry)
        return;
      }
      m.scene.scale.setScalar(cfg.scale);
      m.scene.rotation.y = cfg.rot;
      const tint = classStats(role, cls).tint; // class colour as an emissive accent on its own materials
      for (const mat of m.materials) { mat.emissive.setHex(tint); mat.emissiveIntensity = 0.35; }
      const idle = pickAction(m.actions, cfg.clips.idle); if (idle) idle.play();
      m.mixer.update(0);
      this.showGroup(m.scene, true);
      this.mi = m;
    });
  }

  /** Centre a group at the pivot origin, frame the camera to its size, and swap it in (disposing the previous). */
  private showGroup(g: THREE.Group, isGltf: boolean): void {
    this.clearModel();
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    g.position.sub(box.getCenter(new THREE.Vector3()));
    this.pivot.add(g);
    this.model = g;
    this._gltf = isGltf;
    const reach = Math.max(size.x, size.y, size.z) || 1;
    this.camera.position.set(0, size.y * 0.08, reach * 2.1 + 0.6);
    this.camera.lookAt(0, 0, 0);
  }
  private _gltf = false;

  /** Match the drawing buffer to the canvas's CSS box (call on layout/resize). */
  resize(): void {
    const w = this.canvas.clientWidth || 260, h = this.canvas.clientHeight || 300;
    this.renderer.setPixelRatio(Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio : 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.clearModel();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // free the GPU context so only the game's remains during play
  }

  private clearModel(): void {
    if (!this.model) return;
    this.pivot.remove(this.model);
    if (this._gltf) {
      // glTF: geometry is SHARED across instances (cloneSkinned) → NEVER dispose it, only this instance's cloned
      // materials + stop the mixer. Disposing shared geometry would corrupt every future/other instance.
      this.mi?.mixer.stopAllAction();
      this.model.traverse((o) => { const mesh = o as THREE.Mesh; if (!mesh.isMesh) return; const mat = mesh.material; if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else if (mat) mat.dispose(); });
    } else {
      this.model.traverse((o) => { // procedural: it owns its geometry + materials → dispose both
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat.dispose();
      });
    }
    this.model = null; this.mi = null;
  }

  private onDown(e: PointerEvent): void { this.dragging = true; this.lastX = e.clientX; }
  private onMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.yaw += (e.clientX - this.lastX) * 0.012;
    this.lastX = e.clientX;
  }
  private onUp(): void { this.dragging = false; }

  private loop(t: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((n) => this.loop(n));
    const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    if (!this.dragging) this.yaw += dt * 0.6; // gentle auto-spin
    this.pivot.rotation.y = this.yaw;
    this.mi?.mixer.update(dt); // advance the glTF idle animation (if a model is showing)
    this.renderer.render(this.scene, this.camera);
  }
}
