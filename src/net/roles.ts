import { roleLoadout, type Weapon } from "./weapons";

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

// ---- Teams (Rojo/Azul) ---------------------------------------------------------------------------
// A team is an axis INDEPENDENT of role. Two players on the same team never damage each other; who is
// an enemy is decided by team, not by avatar type. So a match is drone-vs-drone when both teams pick
// drones, human-vs-human when both pick soldiers, or mixed — whatever each player chooses.
export type Team = 0 | 1;

/** HUD/avatar accent per team: 0 = Rojo, 1 = Azul. */
export const TEAM_COLOR: Record<Team, number> = { 0: 0xff4a4a, 1: 0x4a8aff };
export const TEAM_LABEL: Record<Team, string> = { 0: "ROJO", 1: "AZUL" };

/** The opposing team. */
export function enemyTeam(t: Team): Team { return t === 0 ? 1 : 0; }

// ---- Classes (4 per side, parallel drone↔soldier) -----------------------------------------------
// Each class is strong on ONE axis (survivability / mobility / range) and weak on the others; the
// "assault" of each side is the balanced middle. The invariant — enforced by tests/classes.test.ts —
// is that no single class leads in HP AND speed AND range at once (rock-paper-scissors, not a ladder).
export type SoldierClass = "assault" | "scout" | "heavy" | "marksman";
export type DroneClass = "assault" | "interceptor" | "armor" | "artillery";
export type UnitClass = SoldierClass | DroneClass;

/** 1–5 ratings for the lobby preview's stat bars. Consistent with the no-dominance rule: each class
 *  maxes exactly ONE of armor/mobility/range (assault maxes none). firepower is the 4th, free axis. */
export interface ClassProfile { armor: number; mobility: number; range: number; firepower: number }

export interface ClassStats {
  label: string;      // HUD/lobby label (Spanish)
  maxHp: number;
  moveMul: number;    // multiplies base move speed (walk/run for a soldier, cruise/boost for a drone)
  jumpMul: number;    // soldier jump multiplier (drones ignore it)
  loadout: Weapon[];  // class arsenal; slot 0 is the primary
  tint: number;       // avatar base colour (team accent is layered on top)
  profile: ClassProfile; // 1–5 bars for the lobby preview
  pros: string[];     // short strengths (chips) — Spanish
  cons: string[];     // short weaknesses (chips) — Spanish
}

export const SOLDIER_CLASSES: Record<SoldierClass, ClassStats> = {
  assault:  { label: "Asalto",     maxHp: 150, moveMul: 1.00, jumpMul: 1.00, loadout: ["mg", "grenade", "shotgun"],    tint: 0x4a5238,
              profile: { armor: 3, mobility: 3, range: 3, firepower: 3 }, pros: ["Todoterreno", "Sin puntos débiles"], cons: ["No sobresale", "Sin especialidad"] },
  scout:    { label: "Explorador", maxHp: 90,  moveMul: 1.35, jumpMul: 1.15, loadout: ["smg", "shotgun"],              tint: 0x3aa0d0,
              profile: { armor: 1, mobility: 5, range: 1, firepower: 3 }, pros: ["Muy rápido", "Letal de cerca"], cons: ["Muy frágil", "Inútil de lejos"] },
  heavy:    { label: "Pesado",     maxHp: 260, moveMul: 0.70, jumpMul: 0.80, loadout: ["lmg", "shotgun", "glauncher"], tint: 0x8a5a2b,
              profile: { armor: 5, mobility: 1, range: 2, firepower: 4 }, pros: ["Mucha vida", "Supresión sostenida"], cons: ["Lento", "Blanco fácil"] },
  marksman: { label: "Tirador",    maxHp: 100, moveMul: 0.90, jumpMul: 1.00, loadout: ["sniper", "dmr", "smoke"],      tint: 0x6a4aa0,
              profile: { armor: 2, mobility: 3, range: 5, firepower: 4 }, pros: ["Un tiro a distancia", "Controla zonas"], cons: ["Cadencia lenta", "Indefenso de cerca"] },
};

export const DRONE_CLASSES: Record<DroneClass, ClassStats> = {
  assault:     { label: "Asalto",      maxHp: 80,  moveMul: 1.00, jumpMul: 1, loadout: ["mg", "grenade"],   tint: 0x3a3f4a,
                 profile: { armor: 3, mobility: 3, range: 3, firepower: 3 }, pros: ["Equilibrado", "Flexible"], cons: ["No sobresale", "Sin especialidad"] },
  interceptor: { label: "Interceptor", maxHp: 55,  moveMul: 1.30, jumpMul: 1, loadout: ["smg", "kamikaze"], tint: 0x2ad0c0,
                 profile: { armor: 1, mobility: 5, range: 1, firepower: 3 }, pros: ["Velocidad extrema", "Caza en vuelo"], cons: ["De papel", "Corto alcance"] },
  armor:       { label: "Blindado",    maxHp: 170, moveMul: 0.65, jumpMul: 1, loadout: ["lmg", "shotgun"],  tint: 0x8a5a2b,
                 profile: { armor: 5, mobility: 1, range: 2, firepower: 4 }, pros: ["Aguanta y empuja", "Cargador enorme"], cons: ["Lento", "Torpe"] },
  artillery:   { label: "Artillero",   maxHp: 70,  moveMul: 0.85, jumpMul: 1, loadout: ["dmr", "grenade"],  tint: 0x6a4aa0,
                 profile: { armor: 2, mobility: 3, range: 5, firepower: 4 }, pros: ["Daño a distancia", "Apoyo aéreo"], cons: ["Frágil de cerca", "Cadencia media"] },
};

function isDroneClass(c: string): c is DroneClass { return Object.prototype.hasOwnProperty.call(DRONE_CLASSES, c); }
function isSoldierClass(c: string): c is SoldierClass { return Object.prototype.hasOwnProperty.call(SOLDIER_CLASSES, c); }

/** The balanced default class of each side (used when no explicit pick is made). */
export function defaultClass(_role: Role): UnitClass { return "assault"; }

/** Stats for a role+class, falling back to that side's "assault" when the class is unknown (e.g. an
 *  older peer that doesn't send one). Pure. */
export function classStats(role: Role, cls: string | undefined): ClassStats {
  if (role === "drone") return DRONE_CLASSES[cls && isDroneClass(cls) ? cls : "assault"];
  return SOLDIER_CLASSES[cls && isSoldierClass(cls) ? cls : "assault"];
}

/** Per-class max HP; with no class chosen, falls back to the role default (roleMaxHp). */
export function classMaxHp(role: Role, cls?: string): number {
  return cls ? classStats(role, cls).maxHp : roleMaxHp(role);
}

/** Per-class loadout (slot 0 = primary). roleLoadout stays the untouched role default. */
export function classLoadout(role: Role, cls?: string): Weapon[] {
  return cls ? classStats(role, cls).loadout.slice() : roleLoadout(role);
}

/** Per-class movement multipliers (drone ignores jumpMul). Default class → neutral 1×. */
export function classMove(role: Role, cls?: string): { speedMul: number; jumpMul: number } {
  const s = classStats(role, cls);
  return { speedMul: s.moveMul, jumpMul: s.jumpMul };
}

/** The selectable classes for a role, in menu order — for the lobby class picker. */
export function classList(role: Role): { id: UnitClass; label: string }[] {
  const t = (role === "drone" ? DRONE_CLASSES : SOLDIER_CLASSES) as Record<string, ClassStats>;
  return Object.keys(t).map((id) => ({ id: id as UnitClass, label: t[id].label }));
}
