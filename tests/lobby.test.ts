import { describe, it, expect } from "vitest";
import { makeRoomCode, emptyLobby, applyJoin, applyLeave, applyPick, hostOf, canStart } from "../src/net/lobby";

describe("lobby — shareable room code", () => {
  it("makes a 5-char code from the unambiguous alphabet (never I/O/0/1)", () => {
    for (let i = 0; i < 300; i++) {
      const c = makeRoomCode();
      expect(c).toHaveLength(5);
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}$/); // excludes I, O, 0, 1
    }
  });
  it("varies across calls (an injected rng drives distinct codes)", () => {
    let x = 0.11; const rng = () => { x = (x + 0.137) % 1; return x; };
    expect(makeRoomCode(rng)).not.toBe(makeRoomCode(rng));
  });
});

describe("lobby — roster reducers (pure, deterministic)", () => {
  it("join adds once (idempotent by id) and keeps the roster sorted", () => {
    let s = emptyLobby();
    s = applyJoin(s, 3); s = applyJoin(s, 1); s = applyJoin(s, 1); // duplicate id ignored
    expect(s.players.map((p) => p.id)).toEqual([1, 3]);
  });
  it("host is the lowest id; leaving promotes the next; empty → null", () => {
    let s = applyJoin(applyJoin(emptyLobby(), 5), 2);
    expect(hostOf(s)).toBe(2);
    s = applyLeave(s, 2);
    expect(hostOf(s)).toBe(5);
    expect(hostOf(emptyLobby())).toBeNull();
  });
  it("hostOf IGNORES the id-0 sentinel (a phantom from a pre-hello lobby action) → the real host is found", () => {
    const s = applyJoin(applyJoin(applyJoin(emptyLobby(), 0), 23), 24); // id 0 = pre-relay-id phantom
    expect(hostOf(s)).toBe(23);                 // NOT 0 → the real host (23) can pass its net.id===hostOf start check
    expect(hostOf(applyJoin(emptyLobby(), 0))).toBeNull(); // phantom-only lobby → null (caller falls back to net.id)
  });
  it("pick sets a player's role (free choice, switchable), joining an unseen id", () => {
    let s = applyJoin(emptyLobby(), 7);
    expect(s.players[0].role).toBeNull();
    s = applyPick(s, 7, "drone");
    expect(s.players[0].role).toBe("drone");
    s = applyPick(s, 7, "human");
    expect(s.players[0].role).toBe("human");
    s = applyPick(s, 9, "drone"); // unseen → auto-joins
    expect(s.players.find((p) => p.id === 9)?.role).toBe("drone");
  });
  it("canStart only once at least one player is present (no balance requirement)", () => {
    expect(canStart(emptyLobby())).toBe(false);
    expect(canStart(applyJoin(emptyLobby(), 1))).toBe(true);
  });
});
