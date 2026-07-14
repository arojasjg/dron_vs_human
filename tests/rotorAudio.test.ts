import { describe, it, expect } from "vitest";
import { rotorLevel, rotorCutoff, rotorPitch, rotorPan, frontBrightness } from "../src/fx/rotorAudio";

const AUD = 34;

describe("drone rotor — spatial audio math (pure)", () => {
  it("rotorLevel: full at the ear, QUADRATIC falloff, and dead silent beyond the audible radius", () => {
    expect(rotorLevel(0, AUD)).toBe(1);
    expect(rotorLevel(AUD, AUD)).toBe(0);       // at the edge → silent
    expect(rotorLevel(AUD + 10, AUD)).toBe(0);  // beyond → still silent (no faraway drone hum)
    expect(rotorLevel(AUD / 2, AUD)).toBeCloseTo(0.25, 5); // quadratic: half distance → quarter loudness
    expect(rotorLevel(AUD / 2, AUD)).toBeLessThan(0.5);    // …quieter than a LINEAR falloff would be
    expect(rotorLevel(-5, AUD)).toBe(1);        // guards a negative distance
  });

  it("rotorCutoff: a far rotor is muffled (low cutoff), a close one is bright (high cutoff)", () => {
    expect(rotorCutoff(AUD, AUD)).toBeCloseTo(450, 0);   // far → dull
    expect(rotorCutoff(0, AUD)).toBeCloseTo(3800, 0);    // near → bright
    expect(rotorCutoff(5, AUD)).toBeGreaterThan(rotorCutoff(25, AUD)); // closer is brighter (monotonic)
  });

  it("rotorPitch: revs UP as the drone closes in (no longer a constant tone)", () => {
    expect(rotorPitch(0, AUD)).toBeGreaterThan(rotorPitch(AUD, AUD)); // close = more revved
    expect(rotorPitch(0, AUD)).toBe(64);
    expect(rotorPitch(AUD, AUD)).toBe(16);
    expect(rotorPitch(AUD + 99, AUD)).toBe(16); // clamped past the edge
  });

  it("rotorPan: pans right/left by bearing; front and behind sit centre", () => {
    expect(rotorPan(0)).toBeCloseTo(0, 6);            // dead ahead → centre
    expect(rotorPan(Math.PI / 2)).toBeCloseTo(1, 6);  // to the right → hard right
    expect(rotorPan(-Math.PI / 2)).toBeCloseTo(-1, 6); // to the left → hard left
    expect(Math.abs(rotorPan(Math.PI))).toBeCloseTo(0, 6); // directly behind → centre (can't tell L/R by pan alone)
  });

  it("frontBrightness: a drone ahead is bright, one behind is duller (the front/back cue pan can't give)", () => {
    expect(frontBrightness(0)).toBeCloseTo(1, 6);          // dead ahead → full brightness
    expect(frontBrightness(Math.PI)).toBeCloseTo(0.4, 6);  // directly behind → dull
    expect(frontBrightness(0)).toBeGreaterThan(frontBrightness(Math.PI / 2)); // ahead brighter than to the side
    expect(frontBrightness(Math.PI / 2)).toBeGreaterThan(frontBrightness(Math.PI)); // side brighter than behind
  });
});
