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
});
