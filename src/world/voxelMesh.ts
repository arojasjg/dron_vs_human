import * as THREE from "three";
import { VOXEL } from "../config";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "./materials";
import { packKey, unpackKey, type VoxelGrid } from "./voxelGrid";
import { meshChunkCoord, cookMeshChunk, NEUTRAL_WEATHER, type CookedMeshPart } from "./cook";

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
      const ck = packKey(meshChunkCoord(x), meshChunkCoord(y), meshChunkCoord(z));
      let b = buckets.get(ck);
      if (!b) { b = []; buckets.set(ck, b); }
      b.push(key);
    }
    for (const [ck, keys] of buckets) this.build(ck, grid, keys);
  }

  /** Rebuilds just one RENDER chunk's meshes from the grid (synchronous cook + apply). */
  rebuildChunk(grid: VoxelGrid, cx: number, cy: number, cz: number): void {
    // Gather the render chunk's voxels from the grid's cell index — O(voxels present), not O(volume).
    this.build(packKey(cx, cy, cz), grid, grid.meshChunkVoxelKeys(cx, cy, cz));
  }

  private build(ck: number, grid: VoxelGrid, keys: number[]): void {
    const matIdx = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) matIdx[i] = MATERIAL_ORDER.indexOf(grid.cells.get(keys[i])!);
    this.applyCooked(ck, cookMeshChunk(keys, matIdx)); // pure cook (the big part) → build the meshes
  }

  /**
   * Builds one chunk's InstancedMeshes from ALREADY-COOKED per-material instance data. The cook (greedy +
   * matrices + weathering colours) can come from the synchronous path OR the off-thread worker — both feed
   * this same apply. Disposes the old chunk meshes atomically here, so there's no visual gap.
   */
  applyCooked(ck: number, parts: CookedMeshPart[]): void {
    const old = this.chunks.get(ck);
    if (old) { for (const mesh of old.values()) this.disposeMesh(mesh); this.chunks.delete(ck); }
    if (parts.length === 0) return;
    const map = new Map<MaterialId, THREE.InstancedMesh>();
    for (const part of parts) {
      const mat = MATERIAL_ORDER[part.matIdx];
      const count = part.matrices.length / 16;
      const mesh = new THREE.InstancedMesh(this.geo, this.mats.get(mat)!, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true; // per-chunk mesh with a computed bounding sphere → drawn only on-screen
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(part.matrices, 16); // reuse cooked buffers (no copy)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(part.colors, 3);
      mesh.computeBoundingSphere();
      // The mesh itself never moves — instances are positioned in world space by instanceMatrix, and the
      // mesh sits at the identity transform. So recomputing its matrix/matrixWorld every frame (the Three.js
      // default) is pure waste over thousands of chunk meshes. Freeze both (measured ~1 ms/frame saved).
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
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
