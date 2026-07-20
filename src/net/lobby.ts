import type { Role } from "./roles";

// Pre-game lobby model — PURE and deterministic so it unit-tests. The game layers networking on top: each
// client broadcasts its own {id, role} and applies peers' messages through these reducers, so every client
// converges on the same roster. The HOST (lowest id = first to join) is the one allowed to start the match.

// Unambiguous code alphabet: no O/0 or I/1 so a shared code can't be mistyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 5;

/** A short shareable room code (5 chars from the unambiguous alphabet). `rng` defaults to Math.random. */
export function makeRoomCode(rng: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}

export interface LobbyPlayer { id: number; role: Role | null; ready: boolean; }
export interface LobbyState { players: LobbyPlayer[]; }

export const emptyLobby = (): LobbyState => ({ players: [] });

/** Adds a player once (idempotent by id); keeps the roster sorted by id so display + host are stable. */
export function applyJoin(s: LobbyState, id: number, role: Role | null = null): LobbyState {
  if (s.players.some((p) => p.id === id)) return s;
  return { players: [...s.players, { id, role, ready: false }].sort((a, b) => a.id - b.id) };
}

export function applyLeave(s: LobbyState, id: number): LobbyState {
  return { players: s.players.filter((p) => p.id !== id) };
}

/** Sets a player's chosen role (free choice — no team-balance constraint). Joins the player if unseen. */
export function applyPick(s: LobbyState, id: number, role: Role): LobbyState {
  if (!s.players.some((p) => p.id === id)) s = applyJoin(s, id, role);
  return { players: s.players.map((p) => (p.id === id ? { ...p, role } : p)) };
}

/** The host is the LOWEST REAL player id (the first to create/join the room). Ignores the id-0 sentinel —
 *  a lobby action taken before the relay assigns an id can leave a phantom id-0 in the roster; counting it
 *  as host would make the true host fail its `net.id === hostOf` check and be unable to start. null on an
 *  empty (or phantom-only) lobby. */
export function hostOf(s: LobbyState): number | null {
  let m = Infinity;
  for (const p of s.players) if (p.id > 0 && p.id < m) m = p.id;
  return m === Infinity ? null : m;
}

/** The host may start once at least one player is present. Roles are free-choice, so there is no balance gate. */
export function canStart(s: LobbyState): boolean {
  return s.players.length >= 1;
}
