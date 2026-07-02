import RAPIER from "@dimforge/rapier3d-compat";
import { AIR_DENSITY, DEFAULT_WIND, FIXED_DT, GRAVITY } from "../config";

// Collision groups (membership<<16 | filter). Rigid debris is kept OUT of the building group so it
// never penetration-fights the building's colliders — which lag the grid by the rebuild debounce,
// so fresh debris would otherwise spawn inside stale-solid colliders and spike the solver. Debris
// just lands on the ground / piles on other debris; the GPU debris layer carries the visual mass.
const M_BUILDING = 0x0001, M_GROUND = 0x0002, M_DEBRIS = 0x0004;
export const GROUP_BUILDING = (M_BUILDING << 16) | 0xffff;
export const GROUP_GROUND = (M_GROUND << 16) | 0xffff;
export const GROUP_DEBRIS = (M_DEBRIS << 16) | (M_GROUND | M_DEBRIS);

export interface BodyUserData {
  /** Cross-section area (m^2) used for aerodynamic drag. */
  area?: number;
  /** Drag coefficient. */
  cd?: number;
  kind?: string;
}

/** Rapier world wrapper that also applies wind + aerodynamic drag every step. */
export class Physics {
  readonly world: RAPIER.World;
  readonly wind = { x: DEFAULT_WIND.x, y: DEFAULT_WIND.y, z: DEFAULT_WIND.z };
  windStrength = 1;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 4;
  }

  step(time: number): void {
    this.applyAir(time);
    this.world.step();
  }

  /** Gust-modulated wind + quadratic drag, applied as a per-step impulse so it never accumulates. */
  private applyAir(time: number): void {
    const gust = (1 + 0.35 * Math.sin(time * 0.7) + 0.15 * Math.sin(time * 2.3)) * this.windStrength;
    const wx = this.wind.x * gust;
    const wy = this.wind.y * gust;
    const wz = this.wind.z * gust;

    this.world.forEachActiveRigidBody((b) => {
      if (!b.isDynamic()) return;
      const ud = b.userData as BodyUserData | undefined;
      // settled rubble and heavy props must not be kept awake (and sliding) by wind — they need
      // to come to rest and SLEEP, or they cost a physics step forever (a steady idle drain).
      if (ud?.kind === "chunk" || ud?.kind === "debris" || ud?.kind === "crate") return;
      const v = b.linvel();
      const rx = v.x - wx, ry = v.y - wy, rz = v.z - wz;
      const speed = Math.hypot(rx, ry, rz);
      if (speed < 1e-4) return;
      const area = ud?.area ?? 0.06;
      const cd = ud?.cd ?? 1.05;
      const k = 0.5 * AIR_DENSITY * cd * area * speed * FIXED_DT;
      b.applyImpulse({ x: -k * rx, y: -k * ry, z: -k * rz }, false);
    });
  }
}
