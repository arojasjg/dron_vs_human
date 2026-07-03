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
