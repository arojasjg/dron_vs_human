// Pure resolver for interactive "hero" debris: given the flying rigid chunks (with their kinetic
// energy), the gas tanks and the local drone, decide which tanks a chunk sets off and how much the
// drone is hurt. Kept pure and dependency-free so it can be unit-tested in isolation, and so the
// gameplay decision is easy to reason about for multiplayer (drone damage is applied locally; tank
// detonations are broadcast by the caller as authoritative explode events).

export interface DebrisImpact { x: number; y: number; z: number; ke: number }
export interface TankTarget { x: number; y: number; z: number; live: boolean }
export interface Point { x: number; y: number; z: number }

export interface ImpactConfig {
  keThreshold: number;      // min kinetic energy for a chunk to matter
  tankR: number;            // detonation radius around a gas tank
  droneR: number;           // hurt radius around the drone
  dmgPerKe: number;         // drone damage per joule of impacting energy
  maxDronePerFrame: number; // clamp so one rubble cloud can't instakill in a single tick
}

export interface ImpactOutcome { tanks: number[]; droneDamage: number }

const dist2 = (a: Point, b: Point) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export function resolveDebrisImpacts(
  debris: readonly DebrisImpact[],
  tanks: readonly TankTarget[],
  drone: Point | null,
  cfg: ImpactConfig,
): ImpactOutcome {
  const tankHit = new Set<number>();
  const tankR2 = cfg.tankR * cfg.tankR, droneR2 = cfg.droneR * cfg.droneR;
  let droneDamage = 0;

  for (const d of debris) {
    if (d.ke < cfg.keThreshold) continue; // slow/light chunk → harmless
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      if (t.live && !tankHit.has(i) && dist2(d, t) <= tankR2) tankHit.add(i);
    }
    if (drone && dist2(d, drone) <= droneR2) droneDamage += d.ke * cfg.dmgPerKe;
  }

  return { tanks: [...tankHit], droneDamage: Math.min(cfg.maxDronePerFrame, Math.round(droneDamage)) };
}
