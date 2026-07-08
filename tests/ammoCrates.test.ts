import { describe, it, expect } from "vitest";
import { nearestLiveCrate, takeCrate, respawnCrates, CRATE_RESPAWN, type CrateState } from "../src/fx/ammoCrates";

const crates = (): CrateState[] => [
  { x: 0, z: 0, live: true, respawnAt: 0 },
  { x: 10, z: 0, live: true, respawnAt: 0 },
  { x: 3, z: 4, live: true, respawnAt: 0 }, // 5 m from the origin
];

describe("ammo crate state machine (pure)", () => {
  it("nearestLive picks the closest LIVE crate within range, else -1", () => {
    const c = crates();
    expect(nearestLiveCrate(c, 0.4, 0.3, 1.6)).toBe(0);  // standing on crate 0
    expect(nearestLiveCrate(c, 100, 100, 1.6)).toBe(-1); // nothing in range
    c[0].live = false;                                    // crate 0 taken → it's skipped
    expect(nearestLiveCrate(c, 0.4, 0.3, 6)).toBe(2);     // crate 2 (5 m) beats crate 1 (10 m)
  });

  it("take() hides a crate and arms its respawn; a second take does NOT reset the timer", () => {
    const c = crates();
    takeCrate(c, 0, 100);
    expect(c[0].live).toBe(false);
    expect(c[0].respawnAt).toBe(100 + CRATE_RESPAWN);
    takeCrate(c, 0, 999);
    expect(c[0].respawnAt).toBe(100 + CRATE_RESPAWN); // idempotent (a duplicate pickup broadcast is a no-op)
  });

  it("respawnCrates brings a crate back only once its timer elapses", () => {
    const c = crates();
    takeCrate(c, 1, 100);
    expect(respawnCrates(c, 100 + CRATE_RESPAWN - 0.01)).toBe(false); // not yet
    expect(c[1].live).toBe(false);
    expect(respawnCrates(c, 100 + CRATE_RESPAWN)).toBe(true);         // now it returns
    expect(c[1].live).toBe(true);
  });
});
