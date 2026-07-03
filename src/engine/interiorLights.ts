import * as THREE from "three";
import { VOXEL } from "../config";

const STRIDE = 19; // voxels between floor slabs — must match prefabs (BIG.H 18 + 1)

/** Fluorescent-ish flicker: an intensity multiplier in [0.15, 1] that wavers with time + a per-light
 *  seed and occasionally stutters dark. Pure, so it unit-tests without a scene. */
export function flicker(t: number, seed: number): number {
  const base = 0.8 + 0.2 * Math.sin(t * 2.1 + seed);
  const stutter = Math.sin(t * 17 + seed * 7) * Math.sin(t * 5.3 + seed) > 0.72 ? 0.35 : 1;
  return Math.max(0.15, base * stutter);
}

interface Placed { ox: number; oz: number; W: number; D: number; FLOORS: number }
interface Lit { light: THREE.PointLight; base: number; flick: boolean; seed: number }

/** Warm, DIM interior point lights placed inside SOME buildings (a deterministic subset — not all),
 *  a third of them flickering. Non-shadow + finite range → cheap; a glow that reads through windows. */
export class InteriorLights {
  private readonly lights: Lit[] = [];
  constructor(private readonly scene: THREE.Scene) {}

  get count(): number { return this.lights.length; }
  get flickerCount(): number { return this.lights.filter((l) => l.flick).length; }

  build(placed: readonly Placed[], max = 8): void {
    this.clear();
    if (max <= 0) return;                                     // "bajo" quality → no interior lights (perf)
    placed.forEach((b, i) => {
      if (this.lights.length >= max) return;                  // cap by the quality budget
      if ((i * 3 + 1) % 5 >= 2) return;                       // light only some buildings, deterministically
      const floor = i % Math.max(1, b.FLOORS);
      const x = (b.ox + b.W / 2) * VOXEL;
      const y = (floor * STRIDE + STRIDE * 0.5) * VOXEL;      // a low-ish floor, mid-storey height
      const z = (b.oz + b.D / 2) * VOXEL;
      const base = 3.2;
      const l = new THREE.PointLight(0xffce8a, base, 15, 2);  // warm tungsten, finite distance, NO shadow
      l.position.set(x, y, z);
      this.scene.add(l);
      this.lights.push({ light: l, base, flick: (i * 7) % 3 === 0, seed: i * 1.7 });
    });
  }

  /** Per-frame: waver the flickering lights (steady ones are left at their base intensity). */
  update(time: number): void {
    for (const l of this.lights) if (l.flick) l.light.intensity = l.base * flicker(time, l.seed);
  }

  clear(): void {
    for (const l of this.lights) this.scene.remove(l.light);
    this.lights.length = 0;
  }
}
