import type { Physics } from "../engine/physics";
import { carveSphere, type CarveTargets } from "./carve";

export type FlashFn = (x: number, y: number, z: number, radius: number) => void;

/** Spherical crater + radial impulse to every nearby dynamic body + smoke/dust/flash. */
export function explode(
  physics: Physics,
  targets: CarveTargets,
  cx: number, cy: number, cz: number,
  radius: number,
  power: number,
  onFlash?: FlashFn,
): { removed: number } {
  const { removed } = carveSphere(targets, cx, cy, cz, radius, power, radius * 5);

  const blastR = radius * 1.9;
  const blastR2 = blastR * blastR;
  physics.world.forEachRigidBody((b) => {
    if (!b.isDynamic()) return;
    const t = b.translation();
    const dx = t.x - cx, dy = t.y - cy, dz = t.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > blastR2) return;
    const d = Math.sqrt(d2) || 1e-3;
    const falloff = 1 - d / blastR;
    const j = power * 0.06 * falloff;
    b.applyImpulse(
      { x: (dx / d) * j, y: (dy / d) * j + j * 0.4, z: (dz / d) * j },
      true,
    );
  });

  // Debris is ONLY the rigid pieces carved from real voxels above — no synthetic
  // "from nothing" fragments. Here we add just the gas/smoke of the blast, kept short
  // so it disperses instead of leaving a cloud stuck to the rubble.
  targets.particles.burst(cx, cy, cz, {
    count: 36, color: 0x3a3a3a, speed: radius * 2.2, size: 16,
    life: 1.5, buoyancy: 2.4, windCoupling: 1.0, spread: radius * 0.6,
    kind: "smoke", strength: 0.16,
  });
  targets.particles.burst(cx, cy, cz, {
    count: 36, color: 0xffb24d, speed: radius * 4.0, size: 8,
    life: 0.45, buoyancy: 1.0, windCoupling: 0.3, spread: radius * 0.3,
    kind: "spark", strength: 0.2,
  });
  targets.particles.burst(cx, cy, cz, {
    count: 24, color: 0x8a7c66, speed: radius * 1.6, size: 12,
    life: 0.9, buoyancy: -1.5, windCoupling: 1.0, spread: radius,
    kind: "dust", strength: 0.12,
  });

  onFlash?.(cx, cy, cz, radius);
  return { removed };
}
