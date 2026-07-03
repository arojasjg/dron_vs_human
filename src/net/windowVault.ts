import { VOXEL } from "../config";

export interface VaultTarget { x: number; y: number; z: number }

type HasFn = (x: number, y: number, z: number) => boolean;

/**
 * Glassless-window climb detection. Given the walker's FEET position (wx,wy,wz) and its horizontal
 * facing (dnx,dnz), decide whether it's right in front of an open window it can clamber through:
 * a solid SILL at foot/knee height, an EMPTY opening at chest height (the glassless gap), and a
 * clear room on the far side to land in. Returns the far-side landing spot, or null.
 *
 * Doors (no sill → you just walk in) and solid/glazed walls (no opening) both return null. Pure —
 * only reads `has` (grid.has or a mock), so it is deterministic and unit-testable headless.
 */
export function windowVault(has: HasFn, wx: number, wy: number, wz: number, dnx: number, dnz: number): VaultTarget | null {
  // snap facing to the dominant horizontal axis so we cross an axis-aligned wall head-on
  let ax = 0, az = 0;
  if (Math.abs(dnx) >= Math.abs(dnz)) ax = dnx >= 0 ? 1 : -1; else az = dnz >= 0 ? 1 : -1;

  const fx = Math.floor(wx / VOXEL), fy = Math.floor(wy / VOXEL), fz = Math.floor(wz / VOXEL);
  const at = (d: number, dy: number) => has(fx + d * ax, fy + dy, fz + d * az);

  // the wall plane may be 1–2 voxels ahead (capsule radius). Look for a window there.
  for (let d = 1; d <= 2; d++) {
    const sill = at(d, 0) || at(d, 1);                 // solid ledge at foot/knee height
    const opening = !at(d, 2) && !at(d, 3);            // empty gap at chest height (no glass)
    if (!sill || !opening) continue;
    // a clear landing two voxels past the wall: room at feet + chest, so the capsule fits
    const clear = !at(d + 1, 0) && !at(d + 2, 0) && !at(d + 2, 2);
    if (!clear) continue;
    return { x: (fx + (d + 2) * ax + 0.5) * VOXEL, y: wy, z: (fz + (d + 2) * az + 0.5) * VOXEL };
  }
  return null;
}
