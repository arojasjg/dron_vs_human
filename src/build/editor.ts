import type * as THREE from "three";
import type { MaterialId } from "../world/materials";
import { VoxelGrid } from "../world/voxelGrid";

const REACH = 60;

/** [x0,y0,z0,x1,y1,z1] voxel-space bounds of the cells an edit touched. */
export type EditRegion = [number, number, number, number, number, number];

/** Places a voxel against the face the player is looking at, or onto the ground. */
export function placeVoxel(
  grid: VoxelGrid,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  material: MaterialId,
  brush = 0,
): EditRegion | null {
  const hit = grid.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, REACH);
  let tx: number, ty: number, tz: number;
  if (hit) {
    tx = hit.vx + hit.normal.x;
    ty = hit.vy + hit.normal.y;
    tz = hit.vz + hit.normal.z;
  } else if (dir.y < -1e-3) {
    const t = -origin.y / dir.y;
    if (t < 0 || t > REACH) return null;
    [tx, ty, tz] = VoxelGrid.worldToVoxel(origin.x + dir.x * t, 0.001, origin.z + dir.z * t);
  } else {
    return null;
  }

  let changed = false;
  for (let dx = -brush; dx <= brush; dx++)
    for (let dy = -brush; dy <= brush; dy++)
      for (let dz = -brush; dz <= brush; dz++) {
        const x = tx + dx, y = ty + dy, z = tz + dz;
        if (y < 0 || grid.has(x, y, z)) continue;
        grid.set(x, y, z, material);
        changed = true;
      }
  return changed ? [tx - brush, ty - brush, tz - brush, tx + brush, ty + brush, tz + brush] : null;
}

/** Removes the voxel under the crosshair (plus the brush neighbourhood). */
export function eraseVoxel(
  grid: VoxelGrid,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  brush = 0,
): EditRegion | null {
  const hit = grid.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, REACH);
  if (!hit) return null;
  let changed = false;
  for (let dx = -brush; dx <= brush; dx++)
    for (let dy = -brush; dy <= brush; dy++)
      for (let dz = -brush; dz <= brush; dz++) {
        if (grid.remove(hit.vx + dx, hit.vy + dy, hit.vz + dz)) changed = true;
      }
  return changed
    ? [hit.vx - brush, hit.vy - brush, hit.vz - brush, hit.vx + brush, hit.vy + brush, hit.vz + brush]
    : null;
}
