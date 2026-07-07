import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelMesher } from "../src/world/voxelMesh";
import { VoxelGrid } from "../src/world/voxelGrid";

describe("VoxelMesher — render scalability", () => {
  it("marks every chunk mesh frustum-culled so off-screen buildings cost nothing", () => {
    const grid = new VoxelGrid();
    // two separated clusters → several chunk meshes across materials
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) grid.set(x, y, z, "brick");
    for (let x = 40; x < 46; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) grid.set(x, y, z, "concrete");

    const mesher = new VoxelMesher(new THREE.Scene());
    mesher.rebuild(grid);

    const meshes = mesher.group.children as THREE.InstancedMesh[];
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      expect(m.frustumCulled).toBe(true);          // culled when off-screen
      expect(m.boundingSphere).toBeTruthy();        // …which requires a computed bounds
    }
  });

  it("injects voxel-pitch surface detail into masonry but leaves glass/metal untouched", () => {
    // the fragile part of onBeforeCompile is the #include anchors — assert they exist in three's source
    const vs = THREE.ShaderLib.standard.vertexShader, fs = THREE.ShaderLib.standard.fragmentShader;
    expect(vs).toContain("#include <project_vertex>");
    expect(vs).toContain("#include <beginnormal_vertex>");
    expect(fs).toContain("#include <color_fragment>");
    expect(fs).toContain("#include <roughnessmap_fragment>");

    const grid = new VoxelGrid();
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) { grid.set(x, y, 0, "brick"); grid.set(x, y, 2, "glass"); }
    const mesher = new VoxelMesher(new THREE.Scene());
    mesher.rebuild(grid);
    const meshes2 = mesher.group.children as THREE.InstancedMesh[];
    const brick = meshes2.find((m) => (m.material as THREE.MeshStandardMaterial).transparent === false)!;
    const glass = meshes2.find((m) => (m.material as THREE.MeshStandardMaterial).transparent === true)!;
    // MeshStandardMaterial ships a no-op onBeforeCompile on its PROTOTYPE, so test for an OWN override.
    expect(Object.prototype.hasOwnProperty.call(brick.material, "onBeforeCompile")).toBe(true);  // masonry patched
    expect(Object.prototype.hasOwnProperty.call(glass.material, "onBeforeCompile")).toBe(false); // glass untouched
  });

  it("gates the mortar detail behind a shared uDetail uniform that setVoxelDetail flips live (no recompile)", () => {
    const grid = new VoxelGrid();
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) grid.set(x, y, 0, "brick");
    const mesher = new VoxelMesher(new THREE.Scene());
    mesher.rebuild(grid);
    const brick = (mesher.group.children as THREE.InstancedMesh[])
      .find((m) => (m.material as THREE.MeshStandardMaterial).transparent === false)!;

    // Run the material's onBeforeCompile against three's real standard shader source (what the GPU compiles).
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, { value: number }>,
    };
    (brick.material as THREE.MeshStandardMaterial).onBeforeCompile!(shader as never, undefined as never);

    // The expensive fwidth/smoothstep block is inside a uniform branch → the GPU can skip it coherently.
    expect(shader.fragmentShader).toContain("uniform float uDetail;");
    expect(shader.fragmentShader).toContain("if (uDetail > 0.5)");
    expect(shader.fragmentShader).toContain("fwidth(gv)");
    expect(shader.uniforms.uDetail).toBeTruthy();            // the material binds the shared uniform
    expect(shader.uniforms.uDetail.value).toBe(1);           // detail on by default

    mesher.setVoxelDetail(false);                            // the perf-floor lever…
    expect(shader.uniforms.uDetail.value).toBe(0);           // …flips the SAME shared object → 0 live
    mesher.setVoxelDetail(true);
    expect(shader.uniforms.uDetail.value).toBe(1);
  });
});
