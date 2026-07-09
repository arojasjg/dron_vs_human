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
  private readonly _imp = { x: 0, y: 0, z: 0 }; // reused impulse vector — no per-body allocation each step (GC)
  private readonly _v = { x: 0, y: 0, z: 0 };   // reused vector for the velocity clamp below

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 4;
  }

  step(time: number): void {
    this.applyAir(time);
    this.sanitize();   // clamp/repair velocities BEFORE stepping — a divergent body traps world.step()
    this.world.step();
  }

  /**
   * Guards world.step() against a numerical blow-up. Extreme destruction can pile several blast impulses
   * onto one body in a single frame (chained gas tanks + a rocket cook-off), and a CCD projectile taking
   * a huge impulse can reach a velocity the solver can't integrate — Rapier then hits a Rust `unreachable`
   * trap INSIDE step(), which unwinds without releasing its borrow, poisoning the whole world so every
   * later physics call throws "recursive use of an object" and the game freezes for good (seen in perf.log).
   * Resetting non-finite velocities and capping the magnitude makes that state unreachable. Deterministic
   * (a pure function of each body's velocity), so it can't desync lockstep clients.
   */
  private sanitize(): void {
    const MAX = 300, MAX2 = MAX * MAX; // m/s — far above any real projectile/debris; only catches runaways
    this.world.forEachActiveRigidBody((b) => {
      if (!b.isDynamic()) return;
      const v = b.linvel();
      const bad = !(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
      const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (bad) {
        this._v.x = 0; this._v.y = 0; this._v.z = 0; b.setLinvel(this._v, false);
        b.setAngvel(this._v, false);
      } else if (s2 > MAX2) {
        const k = MAX / Math.sqrt(s2);
        this._v.x = v.x * k; this._v.y = v.y * k; this._v.z = v.z * k; b.setLinvel(this._v, false);
      }
      const w = b.angvel();
      if (!(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z))) {
        this._v.x = 0; this._v.y = 0; this._v.z = 0; b.setAngvel(this._v, false);
      }
    });
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
      this._imp.x = -k * rx; this._imp.y = -k * ry; this._imp.z = -k * rz; // reuse (Rapier copies into WASM)
      b.applyImpulse(this._imp, false);
    });
  }
}
