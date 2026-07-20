import { describe, it, expect } from "vitest";
import { buildScoreboard, type ScoreRow } from "../src/net/roles";

const row = (o: Partial<ScoreRow>): ScoreRow => ({
  id: 0, team: 0, isHuman: false, kills: 0, assists: 0, deaths: 0, you: false, ...o,
});

describe("buildScoreboard — grouping + stable sort", () => {
  it("groups by team: all team 0 before team 1", () => {
    const out = buildScoreboard([
      row({ id: 1, team: 1 }), row({ id: 2, team: 0 }), row({ id: 3, team: 1 }), row({ id: 4, team: 0 }),
    ]);
    expect(out.map((r) => r.team)).toEqual([0, 0, 1, 1]);
  });

  it("within a team sorts kills-desc", () => {
    const out = buildScoreboard([
      row({ id: 1, team: 0, kills: 2 }), row({ id: 2, team: 0, kills: 5 }), row({ id: 3, team: 0, kills: 3 }),
    ]);
    expect(out.map((r) => r.kills)).toEqual([5, 3, 2]);
  });

  it("breaks equal kills by deaths-asc", () => {
    const out = buildScoreboard([
      row({ id: 1, team: 0, kills: 4, deaths: 3 }), row({ id: 2, team: 0, kills: 4, deaths: 1 }),
    ]);
    expect(out.map((r) => r.id)).toEqual([2, 1]);
  });

  it("breaks equal kills+deaths by id-asc (stable, deterministic order)", () => {
    const out = buildScoreboard([
      row({ id: 9, team: 0, kills: 1, deaths: 1 }), row({ id: 3, team: 0, kills: 1, deaths: 1 }),
    ]);
    expect(out.map((r) => r.id)).toEqual([3, 9]);
  });

  it("preserves the `you` flag through the sort", () => {
    const out = buildScoreboard([
      row({ id: 1, team: 0, kills: 1 }), row({ id: 2, team: 0, kills: 9, you: true }),
    ]);
    expect(out[0].id).toBe(2);
    expect(out[0].you).toBe(true);
    expect(out[1].you).toBe(false);
  });

  it("does not mutate the input array", () => {
    const input = [row({ id: 1, team: 1 }), row({ id: 2, team: 0 })];
    const snapshot = input.map((r) => r.id);
    buildScoreboard(input);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});
