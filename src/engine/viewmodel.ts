import * as THREE from "three";
import { instanceModel, type ModelInstance } from "./modelLoader";
import type { Weapon } from "../net/weapons";

// First-person held-weapon viewmodel: a downloaded CC0 blaster shown low-right of the view, tracking the
// camera each frame (parented to the SCENE and driven from the camera's world transform, so it never depends
// on the camera sitting in the scene graph). It bobs while walking, kicks back on fire, and dips while
// sprinting. Soldiers only — a flying drone holds nothing. A model that fails to load just shows nothing;
// the game is otherwise unaffected (the HUD weapon bar remains the source of truth).

interface WeaponView { url: string; scale: number; pos: [number, number, number]; rot: [number, number, number]; }

// Each firearm maps to a distinct Kenney Blaster Kit model (CC0). Throwables/special weapons reuse a compact
// model or the grenade. `pos` is metres in camera space (x right, y up, z forward: negative = ahead); `rot`
// aims the barrel down -Z and cants the grip. Tuned to read well at the default FOV; refined in-browser.
const VIEWS: Record<Weapon, WeaponView> = {
  mg:        { url: "models/weapons/blaster-h.glb", scale: 0.5,  pos: [0.16, -0.17, -0.34], rot: [0, Math.PI, 0] },
  smg:       { url: "models/weapons/blaster-b.glb", scale: 0.55, pos: [0.15, -0.16, -0.30], rot: [0, Math.PI, 0] },
  lmg:       { url: "models/weapons/blaster-f.glb", scale: 0.5,  pos: [0.17, -0.18, -0.36], rot: [0, Math.PI, 0] },
  shotgun:   { url: "models/weapons/blaster-l.glb", scale: 0.5,  pos: [0.16, -0.17, -0.34], rot: [0, Math.PI, 0] },
  sniper:    { url: "models/weapons/blaster-e.glb", scale: 0.42, pos: [0.15, -0.16, -0.40], rot: [0, Math.PI, 0] },
  dmr:       { url: "models/weapons/blaster-a.glb", scale: 0.5,  pos: [0.16, -0.17, -0.36], rot: [0, Math.PI, 0] },
  glauncher: { url: "models/weapons/blaster-r.glb", scale: 0.5,  pos: [0.16, -0.17, -0.34], rot: [0, Math.PI, 0] },
  grenade:   { url: "models/props/grenade-a.glb",   scale: 0.9,  pos: [0.14, -0.18, -0.28], rot: [0, 0, 0] },
  smoke:     { url: "models/props/grenade-a.glb",   scale: 0.9,  pos: [0.14, -0.18, -0.28], rot: [0, 0, 0] },
  swarm:     { url: "models/weapons/blaster-b.glb", scale: 0.55, pos: [0.15, -0.16, -0.30], rot: [0, Math.PI, 0] },
  net:       { url: "models/weapons/blaster-b.glb", scale: 0.55, pos: [0.15, -0.16, -0.30], rot: [0, Math.PI, 0] },
  kamikaze:  { url: "models/weapons/blaster-b.glb", scale: 0.55, pos: [0.15, -0.16, -0.30], rot: [0, Math.PI, 0] },
  flak:      { url: "models/weapons/blaster-r.glb", scale: 0.5,  pos: [0.16, -0.17, -0.34], rot: [0, Math.PI, 0] }, // chunky launcher
  emp:       { url: "models/props/grenade-a.glb",   scale: 0.9,  pos: [0.14, -0.18, -0.28], rot: [0, 0, 0] },       // thrown device
  lockon:    { url: "models/weapons/blaster-e.glb", scale: 0.42, pos: [0.15, -0.16, -0.40], rot: [0, Math.PI, 0] }, // long missile launcher
  turret:    { url: "models/weapons/blaster-k.glb", scale: 0.5,  pos: [0.16, -0.17, -0.32], rot: [0, Math.PI, 0] }, // deploy device
  laser:     { url: "models/weapons/blaster-c.glb", scale: 0.5,  pos: [0.16, -0.17, -0.32], rot: [0, Math.PI, 0] }, // sleek beam emitter
};

export class Viewmodel {
  private readonly rig = new THREE.Group();      // camera-tracked; the model rides inside it
  private mi: ModelInstance | null = null;       // current held model (own materials)
  private view: WeaponView | null = null;        // current weapon's base transform
  private loadToken = 0;                          // guards a stale async load after a fast weapon switch
  private curWeapon: Weapon | null = null;
  private visible = false;
  private bob = 0;                                // walk-cycle phase
  private recoil = 0;                             // 0..1 kick, decays each frame

  constructor(private readonly scene: THREE.Scene) {
    this.rig.visible = false;
    this.scene.add(this.rig);
  }

  /** Show the model for `weapon` (soldiers only). `role !== "human"` or hidden → nothing is drawn. */
  setWeapon(weapon: Weapon, role: string): void {
    if (role !== "human") { this.setVisible(false); this.curWeapon = null; this.clearModel(); return; }
    if (weapon === this.curWeapon) return;
    this.curWeapon = weapon;
    const view = VIEWS[weapon];
    this.view = view;
    const token = ++this.loadToken;
    this.clearModel();
    void instanceModel(view.url).then((m) => {
      if (!m || token !== this.loadToken) { if (m) this.disposeInstance(m); return; } // stale / failed → drop
      m.scene.scale.setScalar(view.scale);
      m.scene.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) me.castShadow = false; }); // a viewmodel shouldn't cast world shadows
      this.rig.add(m.scene);
      this.mi = m;
    });
  }

  setVisible(v: boolean): void { this.visible = v; this.rig.visible = v && !!this.mi; }

  /** World position of the held gun's BARREL TIP (for the muzzle flash), or null if no gun is shown. Derived
   *  from the weapon's camera-space offset pushed forward past the model — so the flash sits ON the gun, not
   *  floating at screen centre. */
  muzzleWorld(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.rig.visible || !this.mi || !this.view) return null;
    const [px, py, pz] = this.view.pos;
    camera.updateMatrixWorld();
    return out.set(px, py, pz - 0.3).applyMatrix4(camera.matrixWorld); // barrel tip in camera space → world
  }

  /** Kick the weapon back on a shot (accumulates for rapid fire, clamped). */
  kick(amount = 0.5): void { this.recoil = Math.min(1, this.recoil + amount); }

  /** Per-frame: track the camera, apply walk-bob (from the caller's pre-shake horizontal speed, m/s, so screen
   *  shake doesn't read as phantom motion) + recoil, decay the kick. Call before rendering. */
  update(dt: number, camera: THREE.Camera, speed: number): void {
    this.rig.visible = this.visible && !!this.mi;
    if (!this.rig.visible || !this.view) return;
    this.rig.position.copy(camera.position);
    this.rig.quaternion.copy(camera.quaternion);

    const model = this.mi!.scene;
    const walking = Math.min(1, speed / 5);
    this.bob += dt * (4 + walking * 8);
    const bobY = Math.sin(this.bob * 2) * 0.008 * walking;
    const bobX = Math.cos(this.bob) * 0.010 * walking;
    const [px, py, pz] = this.view.pos;
    const [rx, ry, rz] = this.view.rot;
    model.position.set(px + bobX, py + bobY - this.recoil * 0.03, pz + this.recoil * 0.09); // kick back (+z toward the eye) + dip
    model.rotation.set(rx - this.recoil * 0.35, ry, rz);
    this.recoil += (0 - this.recoil) * Math.min(1, dt * 12); // spring back
  }

  private clearModel(): void {
    if (!this.mi) return;
    this.rig.remove(this.mi.scene);
    this.disposeInstance(this.mi);
    this.mi = null;
  }

  private disposeInstance(m: ModelInstance): void {
    m.mixer.stopAllAction();
    m.scene.traverse((o) => { // glTF geometry is SHARED across instances → dispose only this clone's materials
      const me = o as THREE.Mesh; if (!me.isMesh) return;
      const mt = me.material;
      if (Array.isArray(mt)) mt.forEach((x) => x.dispose()); else if (mt) mt.dispose();
    });
  }
}
