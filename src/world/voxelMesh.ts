import * as THREE from "three";
import { VOXEL } from "../config";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "./materials";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";
import { CHUNK, chunkCoord, greedyBoxesFromKeys } from "./voxelCollider";
import { weatherMul } from "./weathering";

const DUMMY = new THREE.Object3D();
const _WCOL = new THREE.Color();

/**
 * Renders the static voxel field as one InstancedMesh per (chunk, material). Rebuilding only
 * touches the chunks that changed, so a destruction event costs O(area touched), not O(world) —
 * this is what keeps a large building fast.
 */
export class VoxelMesher {
  readonly group = new THREE.Group();
  private readonly geo: THREE.BoxGeometry;
  private readonly mats = new Map<MaterialId, THREE.MeshStandardMaterial>();
  private readonly chunks = new Map<number, Map<MaterialId, THREE.InstancedMesh>>();

  constructor(scene: THREE.Scene) {
    this.geo = new THREE.BoxGeometry(1, 1, 1); // unit cube, scaled per greedy box
    for (const id of MATERIAL_ORDER) {
      const def = MATERIALS[id];
      this.mats.set(id, new THREE.MeshStandardMaterial({
        color: def.color, roughness: def.roughness, metalness: def.metalness,
        transparent: def.opacity < 1, opacity: def.opacity,
      }));
    }
    scene.add(this.group);
  }

  /** Full rebuild — used at load time and after stamping prefabs. */
  rebuild(grid: VoxelGrid): void {
    for (const m of this.chunks.values()) for (const mesh of m.values()) this.disposeMesh(mesh);
    this.chunks.clear();

    const buckets = new Map<number, number[]>();
    for (const key of grid.cells.keys()) {
      const [x, y, z] = unpackKey(key);
      const ck = packKey(chunkCoord(x), chunkCoord(y), chunkCoord(z));
      let b = buckets.get(ck);
      if (!b) { b = []; buckets.set(ck, b); }
      b.push(key);
    }
    for (const [ck, keys] of buckets) this.build(ck, grid, keys);
  }

  /** Rebuilds just one chunk's meshes from the grid. */
  rebuildChunk(grid: VoxelGrid, cx: number, cy: number, cz: number): void {
    const ck = packKey(cx, cy, cz);
    const old = this.chunks.get(ck);
    if (old) { for (const mesh of old.values()) this.disposeMesh(mesh); this.chunks.delete(ck); }

    const keys: number[] = [];
    const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK; x++)
      for (let y = y0; y < y0 + CHUNK; y++)
        for (let z = z0; z < z0 + CHUNK; z++)
          if (grid.has(x, y, z)) keys.push(packKey(x, y, z));
    if (keys.length) this.build(ck, grid, keys);
  }

  private build(ck: number, grid: VoxelGrid, keys: number[]): void {
    const byMat = new Map<MaterialId, number[]>();
    for (const key of keys) {
      const mat = grid.cells.get(key)!;
      let arr = byMat.get(mat);
      if (!arr) { arr = []; byMat.set(mat, arr); }
      arr.push(key);
    }

    const map = new Map<MaterialId, THREE.InstancedMesh>();
    for (const [mat, list] of byMat) {
      // merge runs of same-material voxels into big boxes → far fewer instances to draw
      const boxes = greedyBoxesFromKeys(list);
      const mesh = new THREE.InstancedMesh(this.geo, this.mats.get(mat)!, boxes.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true; // per-chunk mesh with a computed bounding sphere → draw only when
                                 // on-screen (and only cast shadows when in the light frustum)
      for (let i = 0; i < boxes.length; i++) {
        const [x0, y0, z0, x1, y1, z1] = boxes[i];
        const sx = (x1 - x0 + 1) * VOXEL, sy = (y1 - y0 + 1) * VOXEL, sz = (z1 - z0 + 1) * VOXEL;
        DUMMY.position.set(x0 * VOXEL + sx / 2, y0 * VOXEL + sy / 2, z0 * VOXEL + sz / 2);
        DUMMY.scale.set(sx, sy, sz);
        DUMMY.rotation.set(0, 0, 0);
        DUMMY.updateMatrix();
        mesh.setMatrixAt(i, DUMMY.matrix);
        // weathering: modulate each box's colour by a deterministic grime/wear/stain factor so walls
        // read as aged, not flat. Per-box (greedy), hashed from the box centre -> stable + client-consistent.
        mesh.setColorAt(i, _WCOL.setScalar(weatherMul((x0 + x1) >> 1, (y0 + y1) >> 1, (z0 + z1) >> 1)));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      map.set(mat, mesh);
    }
    this.chunks.set(ck, map);
  }

  private disposeMesh(mesh: THREE.InstancedMesh): void {
    this.group.remove(mesh);
    mesh.dispose();
  }
}
