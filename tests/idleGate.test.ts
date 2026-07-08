import { describe, it, expect } from "vitest";
import { idleGate, SETTLE_MARGIN } from "../src/fx/idleGate";

describe("particle idle gate", () => {
  it("stays INACTIVE forever when no emitter is ever armed (the whole cost-saving point)", () => {
    let s = { active: true, aliveUntil: 0 };
    for (let t = 0; t < 100; t++) s = idleGate(t, s.aliveUntil, -1); // -1 = nothing armed
    expect(s.active).toBe(false);
  });

  it("opens on an armed burst and stays open exactly through life + settle margin, then closes", () => {
    // a burst at t=10 with life=2 → alive until 10 + 2 + margin
    const armed = idleGate(10, 0, 2);
    expect(armed.active).toBe(true);
    expect(armed.aliveUntil).toBe(10 + 2 + SETTLE_MARGIN);
    // still active just before the window ends...
    expect(idleGate(12.9, armed.aliveUntil, -1).active).toBe(true);
    // ...and inactive just after
    expect(idleGate(13.1, armed.aliveUntil, -1).active).toBe(false);
  });

  it("takes the MAX end-time across overlapping bursts", () => {
    let s = idleGate(10, 0, 1);      // ends at 12
    s = idleGate(10.5, s.aliveUntil, 4); // a longer burst → ends at 15.5
    expect(s.aliveUntil).toBe(15.5);
    expect(idleGate(15.4, s.aliveUntil, -1).active).toBe(true);
    expect(idleGate(15.6, s.aliveUntil, -1).active).toBe(false);
  });
});
