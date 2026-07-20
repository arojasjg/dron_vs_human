import { describe, it, expect } from "vitest";
import { buildScoreboard, mvp, type ScoreRow } from "../src/net/roles";

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

describe("mvp — match most-valuable player", () => {
  it("picks the most kills", () => {
    const out = mvp([
      row({ id: 1, kills: 2 }), row({ id: 2, kills: 7 }), row({ id: 3, kills: 5 }),
    ]);
    expect(out?.id).toBe(2);
  });

  it("breaks equal kills by assists-desc", () => {
    const out = mvp([
      row({ id: 1, kills: 4, assists: 1 }), row({ id: 2, kills: 4, assists: 6 }),
    ]);
    expect(out?.id).toBe(2);
  });

  it("breaks equal kills+assists by deaths-asc", () => {
    const out = mvp([
      row({ id: 1, kills: 4, assists: 2, deaths: 5 }), row({ id: 2, kills: 4, assists: 2, deaths: 1 }),
    ]);
    expect(out?.id).toBe(2);
  });

  it("breaks a full tie by id-asc", () => {
    const out = mvp([
      row({ id: 9, kills: 3, assists: 2, deaths: 1 }), row({ id: 4, kills: 3, assists: 2, deaths: 1 }),
    ]);
    expect(out?.id).toBe(4);
  });

  it("returns null for an empty roster", () => {
    expect(mvp([])).toBeNull();
  });

  it("does not mutate the input array", () => {
    const input = [row({ id: 1, kills: 1 }), row({ id: 2, kills: 9 }), row({ id: 3, kills: 3 })];
    const snapshot = input.map((r) => r.id);
    mvp(input);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});
