import * as THREE from "three";
import { classStats, classLoadout, type Role } from "./roles";
import { WEAPONS, type Weapon } from "./weapons";

// Procedural per-class avatars for the lobby preview. The SILHOUETTE (scale/bulk/rotors/weapon…) is derived
// PURELY from the class stats so it stays consistent with balance and is unit-testable without a renderer;
// buildClassModel() then assembles low-poly primitives in the game's blocky style. Each class reads
// distinct at a glance: heavy = big + shoulder plates, scout = slim, marksman = long scoped rifle;
// armor drone = large + 6 rotors, interceptor = sleek, artillery = long belly cannon.

export interface Silhouette {
  scale: number;      // overall size multiplier
  bulk: number;       // torso/core girth
  weapon: Weapon;     // the class primary — shapes the held weapon prop
  rotors: number;     // drone rotor count (4 or 6)
  longBarrel: boolean; // long-range weapon → long barrel + scope
  plates: boolean;    // heavy armour → shoulder/hull plates
  tint: number;       // class base colour
}

/** Derive a class's visual silhouette from its (balance-consistent) stat profile. Pure. */
export function classSilhouette(role: Role, cls: string): Silhouette {
  const st = classStats(role, cls);
  const p = st.profile;
  return {
    scale: +(0.85 + (p.armor - p.mobility) * 0.05).toFixed(3), // heavy grows, scout shrinks
    bulk: +(0.7 + p.armor * 0.12).toFixed(3),
    weapon: classLoadout(role, cls)[0],
    rotors: p.armor >= 4 ? 6 : 4,
    longBarrel: p.range >= 5,
    plates: p.armor >= 5,
    tint: st.tint,
  };
}

// approximate length (m) of each weapon prop — drives the held-model silhouette
const WEAPON_LEN: Record<string, number> = {
  smg: 0.34, mg: 0.46, lmg: 0.62, sniper: 0.82, dmr: 0.66, shotgun: 0.5, glauncher: 0.52, grenade: 0.42, kamikaze: 0.32,
};

/** A held weapon prop (Group), roughly to scale, with a scope for scoped weapons and a fat body for the lmg. */
function buildWeapon(weapon: Weapon, gun: THREE.Material, accent: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const len = WEAPON_LEN[weapon] ?? 0.46;
  const spec = WEAPONS[weapon];
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, len), gun); g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len * 0.7, 8), gun);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = len * 0.7; g.add(barrel);
  if (weapon === "lmg") { // heavy: fat receiver + ammo drum
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12), accent);
    drum.rotation.z = Math.PI / 2; drum.position.set(0, -0.12, 0); g.add(drum);
  } else { // rifle magazine
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.06), accent); mag.position.set(0, -0.12, 0); g.add(mag);
  }
  if (spec?.scope) { // sniper/dmr optic
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.16, 10), accent);
    scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.08, len * 0.1); g.add(scope);
  }
  return g;
}

/** Build a procedural, class-distinct avatar centred near the origin, facing +Z, ~1.8 m tall (soldier) or
 *  ~0.9 m span (drone). Caller owns disposal (walk children → geometry/material .dispose()). */
export function buildClassModel(role: Role, cls: string): THREE.Group {
  const s = classSilhouette(role, cls);
  const col = new THREE.Color(s.tint);
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.75, metalness: 0.25 });
  const gearMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.5), roughness: 0.85 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.5, metalness: 0.6 });
  const root = new THREE.Group();

  if (role === "human") {
    const w = s.bulk;
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34 * w, 0.2, 0.24), bodyMat); hips.position.y = 0.9; root.add(hips);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42 * w, 0.5, 0.26), bodyMat); torso.position.y = 1.2; root.add(torso);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.46 * w, 0.42, 0.3), gearMat); vest.position.set(0, 1.18, 0.02); root.add(vest);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), bodyMat); head.position.y = 1.6; root.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.6), gearMat); helmet.position.y = 1.62; root.add(helmet);
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.44, 0.12), bodyMat); arm.position.set(sx * 0.3 * w, 1.16, 0.02); root.add(arm);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.16), gearMat); leg.position.set(sx * 0.11, 0.6, 0); root.add(leg);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.28), gunMat); boot.position.set(sx * 0.11, 0.3, 0.05); root.add(boot);
      if (s.plates) { const pad = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), gearMat); pad.position.set(sx * 0.34 * w, 1.34, 0.02); root.add(pad); }
    }
    const gun = buildWeapon(s.weapon, gunMat, gearMat); gun.position.set(0.16, 1.16, 0.2); root.add(gun); // held across the chest
  } else {
    // drone quadcopter — core + N arms/rotors, optional belly cannon
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.34 * s.bulk, 0.13, 0.5 * s.bulk), bodyMat); root.add(core);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.1 * s.bulk, 12, 8), gearMat); dome.position.y = 0.11; root.add(dome);
    const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), gunMat); gimbal.position.set(0, -0.09, 0.16); root.add(gimbal);
    for (let k = 0; k < s.rotors; k++) {
      const a = (k / s.rotors) * Math.PI * 2 + Math.PI / s.rotors;
      const r = 0.3 * s.bulk, ex = Math.cos(a) * r, ez = Math.sin(a) * r;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s.bulk, 0.035, 0.055), gearMat); arm.rotation.y = -a; root.add(arm);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.08, 10), gunMat); motor.position.set(ex, 0.03, ez); root.add(motor);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.012, 18), gearMat); rotor.position.set(ex, 0.09, ez); root.add(rotor);
    }
    for (const sx of [-1, 1]) { const skid = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.36), gunMat); skid.position.set(sx * 0.14, -0.14, 0); root.add(skid); }
    if (s.longBarrel) { // artillery belly cannon
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.55, 10), gunMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, -0.12, 0.3); root.add(barrel);
    }
  }

  root.scale.setScalar(s.scale);
  return root;
}
