export type Role = "drone" | "human";

/**
 * Assigns a role to a joining player so the two teams stay balanced. Deterministic given the
 * current roster and the joiner's stable network id (used only to break an exact tie), so every
 * client in the room computes the same assignment for the same join order.
 */
export function assignRole(existing: readonly Role[], joinerId: number): Role {
  let drones = 0, humans = 0;
  for (const r of existing) r === "drone" ? drones++ : humans++;
  if (drones < humans) return "drone";
  if (humans < drones) return "human";
  return joinerId % 2 === 0 ? "drone" : "human"; // exact tie → deterministic by id parity
}

/** Per-role max health: the human on foot is a tank, the drone is fragile but agile. */
export function roleMaxHp(role: Role): number {
  return role === "human" ? 150 : 80;
}

export interface WeaponMods { cooldownMul: number; powerMul: number }

/** Per-role weapon feel: the flying drone fires fast but light; the human on foot fires slow but
 *  heavy. Only fire-rate (local) and blast power (broadcast deterministically) are scaled — NOT
 *  projectile speed, so remote "ghost" arcs stay matched. (HP-per-hit is a fixed radius formula.) */
export function roleWeapon(role: Role): WeaponMods {
  return role === "human"
    ? { cooldownMul: 1.0, powerMul: 1.4 }
    : { cooldownMul: 0.6, powerMul: 0.75 };
}

/** Team sizes for a roster — handy for the HUD and win checks. */
export function teamCounts(roster: readonly Role[]): { drones: number; humans: number } {
  let drones = 0, humans = 0;
  for (const r of roster) r === "drone" ? drones++ : humans++;
  return { drones, humans };
}
