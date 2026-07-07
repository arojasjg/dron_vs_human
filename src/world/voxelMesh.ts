import * as THREE from "three";
import { VOXEL } from "../config";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "./materials";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";
import { chunkCoord, greedyBoxesFromKeys } from "./voxelCollider";
import { weatherTint, type RGB } from "./weathering";

const DUMMY = new THREE.Object3D();
const _WCOL = new THREE.Color();
const _WRGB: RGB = { r: 1, g: 1, b: 1 };
// materials kept NEUTRAL by weathering (painted/reflective/glass) so chromatic grime doesn't dirty their
// speculars; everything else (masonry, concrete, wood) gets the full chromatic staining.
const NEUTRAL_WEATHER = new Set<MaterialId>(["glass", "metal", "tire", "gastank", "car_red", "car_blue", "car_teal"]);

// Voxel-pitch surface detail injected into MeshStandardMaterial: darken thin (fwidth-AA'd) mortar/plank
// seams at each VOXEL boundary on the two axes tangent to the face, plus per-voxel albedo/roughness
// jitter. Shared function reference across all masonry mats → three compiles ONE program variant.
// Injects at documented #include anchors (r0.18x); a unit test asserts the anchors exist.
//
// The whole block is gated behind a shared `uDetail` uniform (uniform control flow → coherent across the
// draw, so the GPU skips the fwidth/smoothstep ALU entirely when it's 0). This is the single biggest
// recoverable per-pixel cost (~4 ms measured); setVoxelDetail(false) flips it live with NO recompile —
// that's how a weak machine drops it to hold 60 fps without a material-type swap.
const VX = VOXEL.toFixed(4);
type DetailUniform = { value: number };
function makeVoxelDetailPatch(detailUniform: DetailUniform): THREE.MeshStandardMaterial["onBeforeCompile"] {
  return (shader) => {
    shader.uniforms.uDetail = detailUniform; // shared object → one setVoxelDetail flips every program's binding
    shader.vertexShader = "varying vec3 vVoxPos;\nvarying vec3 vVoxNrm;\n" + shader.vertexShader
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n  vVoxNrm = objectNormal;")
      .replace("#include <project_vertex>",
        "#include <project_vertex>\n  { vec4 vxwp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n    vxwp = instanceMatrix * vxwp;\n#endif\n    vVoxPos = (modelMatrix * vxwp).xyz; }");
    // One injection only (a single hash), so the added fragment ALU stays small. A cheap dot-based hash
    // (no transcendental sin, which is costly per-fragment) drives both the albedo jitter and roughness.
    shader.fragmentShader = "varying vec3 vVoxPos;\nvarying vec3 vVoxNrm;\nuniform float uDetail;\n" + shader.fragmentShader
      .replace("#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  if (uDetail > 0.5) {\n    vec3 gv = vVoxPos / " + VX + ";\n    vec3 gf = abs(fract(gv) - 0.5);\n    vec3 gw = fwidth(gv) * 1.5 + 1e-4;\n    vec3 seam = smoothstep(vec3(0.5), vec3(0.5) - gw, gf);\n    vec3 nn = abs(normalize(vVoxNrm));\n    float mortar = max(max(seam.x*(1.0-nn.x), seam.y*(1.0-nn.y)), seam.z*(1.0-nn.z));\n    vec3 c = floor(gv); float hsh = fract((c.x*0.13 + c.y*0.71 + c.z*0.31) * 43.75);\n    diffuseColor.rgb *= mix(1.0, 0.66, mortar * 0.7) * (0.95 + hsh * 0.09);\n    roughnessFactor = clamp(roughnessFactor + (hsh - 0.5) * 0.16, 0.04, 1.0);\n  }");
  };
}

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
  // Shared across every masonry program: setVoxelDetail flips this one .value → all seam shaders gate off
  // together on the next render, no recompile. 1 = full surface detail, 0 = flat (the perf floor lever).
  private readonly detailUniform: DetailUniform = { value: 1 };

  constructor(scene: THREE.Scene) {
    this.geo = new THREE.BoxGeometry(1, 1, 1); // unit cube, scaled per greedy box
    const patchVoxelDetail = makeVoxelDetailPatch(this.detailUniform); // one reference → three compiles ONE program
    for (const id of MATERIAL_ORDER) {
      const def = MATERIALS[id];
      const mat = new THREE.MeshStandardMaterial({
        color: def.color, roughness: def.roughness, metalness: def.metalness,
        transparent: def.opacity < 1, opacity: def.opacity,
      });
      // Masonry (not glass/painted metal) gets voxel-pitch surface detail so a greedy-merged slab
      // visually re-subdivides into coursing at the destruction granularity — kills the "flat box" look.
      if (!NEUTRAL_WEATHER.has(id)) mat.onBeforeCompile = patchVoxelDetail;
      this.mats.set(id, mat);
    }
    scene.add(this.group);
  }

  /** Live toggle of the voxel-pitch surface detail (mortar seams + hash). Off recovers the ~4 ms fwidth
   *  fragment cost with no recompile — the last visual dropped before the preset itself when holding 60 fps. */
  setVoxelDetail(on: boolean): void {
    this.detailUniform.value = on ? 1 : 0;
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

    // Gather the chunk's voxels from the grid's cell index — O(voxels present), not 32768 has()-probes.
    const keys = grid.chunkVoxelKeys(cx, cy, cz);
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
        // weathering: modulate each box's colour by a deterministic chromatic grime/wear/rust factor so
        // walls read as aged masonry, not flat. Per-box (greedy), hashed from the box centre → stable +
        // client-consistent. Painted/reflective materials stay neutral so speculars stay clean.
        const t = weatherTint((x0 + x1) >> 1, (y0 + y1) >> 1, (z0 + z1) >> 1, !NEUTRAL_WEATHER.has(mat), _WRGB);
        mesh.setColorAt(i, _WCOL.setRGB(t.r, t.g, t.b));
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
