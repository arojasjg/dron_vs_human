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
  lockon:    { url: "", scale: 1, pos: [0.16, -0.17, -0.36], rot: [0, 0, 0] }, // PROCEDURAL missile launcher (built in setWeapon, barrel already down -Z)
  turret:    { url: "models/weapons/blaster-k.glb", scale: 0.5,  pos: [0.16, -0.17, -0.32], rot: [0, Math.PI, 0] }, // deploy device
  laser:     { url: "models/weapons/blaster-c.glb", scale: 0.5,  pos: [0.16, -0.17, -0.32], rot: [0, Math.PI, 0] }, // sleek beam emitter
};

export class Viewmodel {
  private readonly rig = new THREE.Group();      // camera-tracked; the model rides inside it
  private mi: ModelInstance | null = null;       // current held model (own materials)
  private proc: THREE.Group | null = null;       // procedurally-built weapon (lockon launcher) — shared geos/mats, scene.remove-only
  private shield: THREE.Group | null = null;     // heavy-class riot shield riding lower-left of the view
  private view: WeaponView | null = null;        // current weapon's base transform
  private loadToken = 0;                          // guards a stale async load after a fast weapon switch
  private curWeapon: Weapon | null = null;
  private visible = false;
  private bob = 0;                                // walk-cycle phase
  private recoil = 0;                             // 0..1 kick, decays each frame
  // shared procedural geometries/materials (one Viewmodel per game → created once, never disposed)
  private readonly launcherTubeGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 12).rotateX(Math.PI / 2);
  private readonly launcherBoxGeo = new THREE.BoxGeometry(0.09, 0.09, 0.3);
  private readonly launcherRingGeo = new THREE.TorusGeometry(0.06, 0.02, 8, 16);
  private readonly launcherRailGeo = new THREE.BoxGeometry(0.02, 0.025, 0.32);
  private readonly launcherSightGeo = new THREE.BoxGeometry(0.016, 0.05, 0.03);
  private readonly launcherGripGeo = new THREE.BoxGeometry(0.03, 0.1, 0.045);
  private readonly launcherBodyMat = new THREE.MeshStandardMaterial({ color: 0x3c444a, roughness: 0.55, metalness: 0.6 });
  private readonly launcherDarkMat = new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.7, metalness: 0.5 });
  private readonly launcherAccentMat = new THREE.MeshStandardMaterial({ color: 0x8a5a1e, roughness: 0.4, metalness: 0.4, emissive: 0x552a08, emissiveIntensity: 0.5 });
  private readonly shieldGeo = new THREE.BoxGeometry(0.36, 0.52, 0.03);
  private readonly shieldRimGeo = new THREE.BoxGeometry(0.4, 0.06, 0.04);
  private readonly shieldSlitGeo = new THREE.BoxGeometry(0.18, 0.07, 0.032);
  private readonly shieldMat = new THREE.MeshStandardMaterial({ color: 0x46545e, roughness: 0.45, metalness: 0.7 });
  private readonly shieldRimMat = new THREE.MeshStandardMaterial({ color: 0x22282c, roughness: 0.6, metalness: 0.6 });
  private readonly shieldSlitMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.4 }); // window slit

  constructor(private readonly scene: THREE.Scene) {
    this.rig.visible = false;
    this.scene.add(this.rig);
  }

  /** Show the model for `weapon` (soldiers only). `role !== "human"` or hidden → nothing is drawn.
   *  `cls === "heavy"` also straps the riot shield to the view. */
  setWeapon(weapon: Weapon, role: string, cls?: string): void {
    this.setShield(role === "human" && cls === "heavy");
    if (role !== "human") { this.setVisible(false); this.curWeapon = null; this.clearModel(); return; }
    if (weapon === this.curWeapon) return;
    this.curWeapon = weapon;
    const view = VIEWS[weapon];
    this.view = view;
    const token = ++this.loadToken;
    this.clearModel();
    if (weapon === "lockon") { this.proc = this.makeLauncher(); this.rig.add(this.proc); return; } // procedural — no glb load
    void instanceModel(view.url).then((m) => {
      if (!m || token !== this.loadToken) { if (m) this.disposeInstance(m); return; } // stale / failed → drop
      m.scene.scale.setScalar(view.scale);
      m.scene.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) me.castShadow = false; }); // a viewmodel shouldn't cast world shadows
      this.rig.add(m.scene);
      this.mi = m;
    });
  }

  /** The currently-held weapon object (glb instance or procedural group), or null. */
  private held(): THREE.Object3D | null { return this.mi ? this.mi.scene : this.proc; }

  /** Procedural missile launcher: fat tube down -Z + boxy receiver + muzzle ring + top rail sight + grip. */
  private makeLauncher(): THREE.Group {
    const g = new THREE.Group();
    const tube = new THREE.Mesh(this.launcherTubeGeo, this.launcherBodyMat);
    const box = new THREE.Mesh(this.launcherBoxGeo, this.launcherDarkMat);
    box.position.set(0, -0.03, 0.08);
    const ring = new THREE.Mesh(this.launcherRingGeo, this.launcherAccentMat); // fat muzzle ring (torus hole faces -Z)
    ring.position.z = -0.3;
    const rail = new THREE.Mesh(this.launcherRailGeo, this.launcherDarkMat);
    rail.position.set(0, 0.065, -0.02);
    const sight = new THREE.Mesh(this.launcherSightGeo, this.launcherAccentMat);
    sight.position.set(0, 0.1, -0.14);
    const grip = new THREE.Mesh(this.launcherGripGeo, this.launcherDarkMat);
    grip.position.set(0, -0.12, 0.12);
    grip.rotation.x = 0.25;
    g.add(tube, box, ring, rail, sight, grip);
    return g;
  }

  /** Adds/removes the heavy-class riot shield: an armored panel lower-left with a small window slit. */
  private setShield(on: boolean): void {
    if (on === !!this.shield) return;
    if (this.shield) { this.rig.remove(this.shield); this.shield = null; return; } // shared geos/mats → no dispose
    const g = new THREE.Group();
    const panel = new THREE.Mesh(this.shieldGeo, this.shieldMat);
    const rimTop = new THREE.Mesh(this.shieldRimGeo, this.shieldRimMat);
    rimTop.position.y = 0.26;
    const rimBot = new THREE.Mesh(this.shieldRimGeo, this.shieldRimMat);
    rimBot.position.y = -0.26;
    const slit = new THREE.Mesh(this.shieldSlitGeo, this.shieldSlitMat);
    slit.position.y = 0.14;
    g.add(panel, rimTop, rimBot, slit);
    g.position.set(-0.3, -0.22, -0.48);
    g.rotation.y = 0.45; // angled toward centre like a braced riot shield
    this.rig.add(g);
    this.shield = g;
  }

  setVisible(v: boolean): void { this.visible = v; this.rig.visible = v && !!this.held(); }

  /** World position of the held gun's BARREL TIP (for the muzzle flash), or null if no gun is shown. Derived
   *  from the weapon's camera-space offset pushed forward past the model — so the flash sits ON the gun, not
   *  floating at screen centre. */
  muzzleWorld(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.rig.visible || !this.held() || !this.view) return null;
    const [px, py, pz] = this.view.pos;
    camera.updateMatrixWorld();
    return out.set(px, py, pz - 0.3).applyMatrix4(camera.matrixWorld); // barrel tip in camera space → world
  }

  /** Kick the weapon back on a shot (accumulates for rapid fire, clamped). */
  kick(amount = 0.5): void { this.recoil = Math.min(1, this.recoil + amount); }

  /** Per-frame: track the camera, apply walk-bob (from the caller's pre-shake horizontal speed, m/s, so screen
   *  shake doesn't read as phantom motion) + recoil, decay the kick. Call before rendering. */
  update(dt: number, camera: THREE.Camera, speed: number): void {
    const model = this.held();
    this.rig.visible = this.visible && !!model;
    if (!this.rig.visible || !this.view || !model) return;
    this.rig.position.copy(camera.position);
    this.rig.quaternion.copy(camera.quaternion);

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
    if (this.proc) { this.rig.remove(this.proc); this.proc = null; } // shared geos/mats → no dispose
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
