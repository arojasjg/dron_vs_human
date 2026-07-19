import type { Role } from "./roles";

/** Live state of a Drones-vs-Humans match. Each team defends 2 bases; a team also scores kills. */
export interface MatchState {
  droneObjsAlive: number; // how many of the DRONE team's bases still stand (0..2)
  humanObjsAlive: number;
  droneKills: number;
  humanKills: number;
}

export interface Kills { drone: number; human: number }

/** Merges two kill tallies by taking the max per team. Kills only ever go up, so max-merging the
 *  score carried in each periodic state message makes the scoreboard self-heal if a `died` event
 *  is dropped: a client that missed it catches up to the peer that saw it. Monotonic + idempotent. */
export function reconcileKills(a: Kills, b: Kills): Kills {
  return { drone: Math.max(a.drone, b.drone), human: Math.max(a.human, b.human) };
}

/** Scores one death: the victim's death is a kill for the ENEMY team. Pure → every client that
 *  receives the death event lands on the same score. */
export function applyDeath(s: MatchState, victim: Role): MatchState {
  return victim === "human"
    ? { ...s, droneKills: s.droneKills + 1 }
    : { ...s, humanKills: s.humanKills + 1 };
}

/** A death only scores a team kill when a real enemy was involved: the finishing damager (`killerId`)
 *  or a recent assist. Environmental/suicide deaths (no enemy in the attribution window) are non-scoring,
 *  so players can't farm the enemy score by dying and accidents don't swing the match. Pure. */
export function deathScores(killerId: number, assistCount = 0): boolean {
  return killerId !== 0 || assistCount > 0;
}

/** Win state for a map with FEWER than 4 objective bases (micro/small presets): with no destroyable
 *  objectives, both sides count as "bases alive" so ONLY the kill limit can end the match — it resolves
 *  instead of running forever. Pure. */
export function killLimitOnlyState(droneKills: number, humanKills: number): MatchState {
  return { droneObjsAlive: 2, humanObjsAlive: 2, droneKills, humanKills }; // 2 = full bases → HUD shows 🟢🟢, never a false 💥
}

/** Base-under-attack thresholds (HP fraction). Crossing one DOWNWARD fires a one-shot alert. */
export const BASE_THRESHOLDS = [0.75, 0.5, 0.25, 0] as const;

/** The highest threshold a base's HP fraction crossed DOWNWARD since last frame (0 = destroyed), or null
 *  if it crossed none. One alert per crossing — a mega-bomb that drops HP straight past several returns the
 *  LOWEST crossed (the most urgent). Pure → same alerts on every client. */
export function baseAlert(prevHp: number, hp: number): number | null {
  if (hp >= prevHp) return null;                     // healing / no change → nothing
  let crossed: number | null = null;
  for (const t of BASE_THRESHOLDS) if (prevHp > t && hp <= t) crossed = t; // take the lowest crossed
  return crossed;
}

/** Which team just won, or null if the match is still going. A team wins by DESTROYING the enemy
 *  objective, or by reaching the kill limit (deathmatch running in parallel). Pure and
 *  dependency-free → identical verdict on every client, so no one desyncs on who won. */
export function checkWin(s: MatchState, killLimit: number): Role | null {
  const droneWins = s.humanObjsAlive === 0 || s.droneKills >= killLimit; // razed BOTH human bases (or kill limit)
  const humanWins = s.droneObjsAlive === 0 || s.humanKills >= killLimit;
  if (droneWins && !humanWins) return "drone";
  if (humanWins && !droneWins) return "human";
  if (droneWins && humanWins) return s.droneKills >= s.humanKills ? "drone" : "human"; // simultaneous → more kills
  return null;
}
