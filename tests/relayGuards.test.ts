import { describe, it, expect } from "vitest";
import { isReservedRelayType } from "../server/relayGuards.mjs";

describe("relay guards — reserved control types", () => {
  it("flags the relay-authoritative control types", () => {
    for (const t of ["hello", "join", "leave"]) expect(isReservedRelayType(t)).toBe(true);
  });

  it("lets every legit client message type through", () => {
    const clientTypes = [
      "ai", "aiboom", "aidead", "aidrop", "aifire", "aihit", "aihitbot", "aistun",
      "ammo", "begin", "coopover", "died", "explode", "gridsync", "lobby", "medkit", "needsync", "smoke",
      "hit", "state", "weapon", "melee", // multi-line sends — keep in sync so a future reserved-type collision fails the test
    ];
    for (const t of clientTypes) expect(isReservedRelayType(t)).toBe(false);
  });

  it("does not flag unknown/empty types", () => {
    for (const t of ["", "unknown", undefined as unknown as string]) expect(isReservedRelayType(t)).toBe(false);
  });
});
