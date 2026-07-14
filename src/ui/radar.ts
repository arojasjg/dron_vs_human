// Pure minimap/radar + on-screen-indicator math. No DOM or three.js, so it unit-tests. World bearings use the
// XZ plane with 0 = +Z ("ahead" when the viewer's heading is 0); the minimap is HEADING-UP (rotates so the
// direction the player faces is always toward the top).

const TAU = Math.PI * 2;

/** Wraps an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** Bearing of a world point relative to a viewer at (vx,vz) facing `heading` (rad, 0 = +Z). 0 = straight
 *  ahead, positive = to the right, ±π = directly behind. Used for both the minimap and the damage arrow. */
export function bearing(heading: number, vx: number, vz: number, tx: number, tz: number): number {
  return wrapAngle(Math.atan2(tx - vx, tz - vz) - heading);
}

/** Projects a world point onto a HEADING-UP radar of pixel size `size` (radius size/2) covering `range` metres.
 *  Returns [mx,my] with origin top-left, the viewer at the centre and "ahead" toward the top — or null if the
 *  point is beyond `range` (nothing to draw). */
export function toRadar(
  heading: number, vx: number, vz: number, tx: number, tz: number, range: number, size: number,
): [number, number] | null {
  const dist = Math.hypot(tx - vx, tz - vz);
  if (dist > range) return null;
  const rel = bearing(heading, vx, vz, tx, tz);
  const r = (dist / range) * (size / 2);
  return [size / 2 + Math.sin(rel) * r, size / 2 - Math.cos(rel) * r]; // up (−Y) = ahead
}

// Compass cardinals as world bearings (0 = +Z, matching bearing()): N=−Z, S=+Z, E=+X, O=−X. Shared with the
// wave-spawn convention so "a wave from the north" appears at the top of the heading-up minimap.
export const COMPASS: { label: "N" | "S" | "E" | "O"; bearing: number }[] = [
  { label: "N", bearing: Math.PI },
  { label: "S", bearing: 0 },
  { label: "E", bearing: Math.PI / 2 },
  { label: "O", bearing: -Math.PI / 2 },
];

/** Screen positions of the four compass letters around a HEADING-UP minimap of pixel `size`, `inset` px in
 *  from the edge. Each letter sits at its world bearing rotated into the map frame (rel = bearing − heading),
 *  so a cardinal is at the TOP when the player faces it and the ring rotates as they turn. Pure — no DOM. */
export function compassMarks(heading: number, size: number, inset = 13): { label: string; x: number; y: number }[] {
  const c = size / 2, rad = c - inset;
  return COMPASS.map(({ label, bearing: b }) => {
    const rel = wrapAngle(b - heading);
    return { label, x: c + Math.sin(rel) * rad, y: c - Math.cos(rel) * rad };
  });
}
