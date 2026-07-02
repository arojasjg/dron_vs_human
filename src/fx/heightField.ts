import * as THREE from "three";
import { VOXEL } from "../config";
import { unpackKey, type VoxelGrid } from "../world/voxelGrid";

const HF = 256;          // texels per axis
const HALF = 40;         // covers world xz in [-HALF, HALF]
const ORIGIN = -HALF;
const SIZE = HALF * 2;
const CELL = SIZE / HF;

/**
 * Top-surface height map of the voxel world, sampled by the GPU particle shaders so
 * millions of particles rest on roofs / ground / debris instead of passing through.
 */
export class HeightField {
  readonly texture: THREE.DataTexture;
  readonly origin = new THREE.Vector2(ORIGIN, ORIGIN);
  readonly size = new THREE.Vector2(SIZE, SIZE);
  private readonly data: Float32Array<ArrayBuffer>;

  constructor() {
    this.data = new Float32Array(HF * HF);
    this.texture = new THREE.DataTexture(this.data, HF, HF, THREE.RedFormat, THREE.FloatType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  rebuild(grid: VoxelGrid): void {
    this.data.fill(0);
    for (const key of grid.cells.keys()) {
      const [x, y, z] = unpackKey(key);
      // mark every cell the voxel's full extent overlaps, so thin walls leave no gaps
      const cx0 = Math.floor((x * VOXEL - ORIGIN) / CELL);
      const cx1 = Math.floor(((x + 1) * VOXEL - 1e-4 - ORIGIN) / CELL);
      const cz0 = Math.floor((z * VOXEL - ORIGIN) / CELL);
      const cz1 = Math.floor(((z + 1) * VOXEL - 1e-4 - ORIGIN) / CELL);
      const top = (y + 1) * VOXEL;
      for (let cz = cz0; cz <= cz1; cz++) {
        if (cz < 0 || cz >= HF) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
          if (cx < 0 || cx >= HF) continue;
          const idx = cz * HF + cx;
          if (top > this.data[idx]) this.data[idx] = top;
        }
      }
    }
    this.texture.needsUpdate = true;
  }
}
