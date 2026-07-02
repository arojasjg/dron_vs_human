import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { VOXEL } from "../config";
import type { Physics } from "../engine/physics";
import { MATERIALS, MATERIAL_ORDER, type MaterialId } from "../world/materials";
import { greedyBoxesFromKeys } from "../world/voxelCollider";
import { packKey, VoxelGrid } from "../world/voxelGrid";
import type { Voxel } from "../world/structuralIntegrity";

const CUBE = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL).toNonIndexed();
const CUBE_POS = CUBE.getAttribute("position").array as Float32Array; // 108 (36 verts)
const CUBE_NORM = CUBE.getAttribute("normal").array as Float32Array;
const VERT_FLOATS = CUBE_POS.length; // 108
const _Q = new THREE.Quaternion();
const _V = new THREE.Vector3();

const MAX_CHUNKS = 16;
const SETTLE_AFTER_SLEEP = 0.4;
/** Hard cap on a chunk's airborne lifetime: one wedged/jittering chunk that never reaches the
 *  rest threshold would otherwise live forever, keeping physics busy and causing idle hitches. */
const CHUNK_MAX_AGE = 6;

interface Chunk {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  sleep: number;
  age: number;
  voxels: Voxel[];
  materials: MaterialId[];
  cx: number; cy: number; cz: number; // spawn-time world centroid (body origin)
}

/** Rigid multi-voxel debris: a section that broke off and falls/tumbles as one solid piece. */
export class ChunkDebris {
  private readonly chunks: Chunk[] = [];
  // one material per type so a chunk looks identical to the same voxels in the world grid
  private readonly mats = new Map<MaterialId, THREE.MeshStandardMaterial>();

  private getMat(id: MaterialId): THREE.MeshStandardMaterial {
    let m = this.mats.get(id);
    if (!m) {
      const def = MATERIALS[id];
      m = new THREE.MeshStandardMaterial({
        vertexColors: true, color: 0xffffff,
        roughness: def.roughness, metalness: def.metalness,
        transparent: def.opacity < 1, opacity: def.opacity,
      });
      this.mats.set(id, m);
    }
    return m;
  }

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
    /** Called per voxel with its resting world transform when a chunk settles, to leave persistent
     *  visual rubble. Settled debris is NOT baked back into the grid — that would churn the
     *  building colliders for every settling piece (a steady post-destruction stutter). */
    private readonly onRubble?: (x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, material: MaterialId) => void,
  ) {}

  get count(): number {
    return this.chunks.length;
  }

  /** Compiles every material's shader program at load time. Otherwise the first chunk of each
   *  material mid-game triggers a ~150ms MeshStandardMaterial program compile inside render(). */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    // match the real chunk geometry (non-indexed + a vertex-colour attribute) and castShadow, so
    // renderer.compile builds BOTH the colour program and the shadow/depth program — the latter is
    // what actually stalls on the first chunk otherwise.
    const geo = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL).toNonIndexed();
    const nv = geo.getAttribute("position").count;
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nv * 3).fill(1), 3));
    const tmp: THREE.Mesh[] = [];
    for (const id of MATERIAL_ORDER) {
      const m = new THREE.Mesh(geo, this.getMat(id));
      m.castShadow = true;
      m.receiveShadow = true;
      m.position.set(0, -100, 0); // out of sight; only needs to exist for compile
      this.scene.add(m);
      tmp.push(m);
    }
    renderer.compile(this.scene, camera);
    for (const m of tmp) this.scene.remove(m);
    geo.dispose();
  }

  /** Builds one dynamic body + merged mesh for a connected group of voxels. */
  spawn(
    voxels: Voxel[],
    materialOf: (x: number, y: number, z: number) => MaterialId,
    vx: number, vy: number, vz: number,
  ): boolean {
    if (voxels.length === 0) return false;
    if (this.chunks.length >= MAX_CHUNKS) this.release(0);

    // centroid + AABB (voxel space) for mass/drag estimation
    let sx = 0, sy = 0, sz = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const counts = new Map<MaterialId, number>();
    for (const [x, y, z] of voxels) {
      const c = VoxelGrid.center(x, y, z);
      sx += c.x; sy += c.y; sz += c.z;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      const m = materialOf(x, y, z);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const n = voxels.length;
    const cx = sx / n, cy = sy / n, cz = sz / n;

    let dominant: MaterialId = "concrete";
    let best = -1;
    for (const [m, c] of counts) if (c > best) { best = c; dominant = m; }
    const def = MATERIALS[dominant];

    const ex = (maxX - minX + 1) * VOXEL, ey = (maxY - minY + 1) * VOXEL, ez = (maxZ - minZ + 1) * VOXEL;
    const area = (ex * ey + ey * ez + ex * ez) / 3;

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(cx, cy, cz)
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 1.2, z: (Math.random() - 0.5) * 1.2 })
        .setLinearDamping(0.2)
        .setAngularDamping(0.9),
    );
    body.userData = { area, cd: 1.0, kind: "chunk" };

    // compound collider from greedy boxes, offset to the body's local frame
    const boxes = greedyBoxesFromKeys(voxels.map(([x, y, z]) => packKey(x, y, z)));
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      const hx = ((x1 - x0 + 1) * VOXEL) / 2;
      const hy = ((y1 - y0 + 1) * VOXEL) / 2;
      const hz = ((z1 - z0 + 1) * VOXEL) / 2;
      const lx = x0 * VOXEL + hx - cx;
      const ly = y0 * VOXEL + hy - cy;
      const lz = z0 * VOXEL + hz - cz;
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(lx, ly, lz)
          .setDensity(def.density).setFriction(def.friction).setRestitution(def.restitution),
        body,
      );
    }

    const mesh = new THREE.Mesh(this.buildGeometry(voxels, materialOf, cx, cy, cz), this.getMat(dominant));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    this.chunks.push({
      body, mesh, sleep: 0, age: 0, cx, cy, cz,
      voxels: voxels.map(([x, y, z]) => [x, y, z] as Voxel),
      materials: voxels.map(([x, y, z]) => materialOf(x, y, z)),
    });
    return true;
  }

  private buildGeometry(
    voxels: Voxel[],
    materialOf: (x: number, y: number, z: number) => MaterialId,
    cx: number, cy: number, cz: number,
  ): THREE.BufferGeometry {
    const n = voxels.length;
    const pos = new Float32Array(n * VERT_FLOATS);
    const norm = new Float32Array(n * VERT_FLOATS);
    const col = new Float32Array(n * VERT_FLOATS);
    const color = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const [x, y, z] = voxels[i];
      const c = VoxelGrid.center(x, y, z);
      const ox = c.x - cx, oy = c.y - cy, oz = c.z - cz;
      const def = MATERIALS[materialOf(x, y, z)];
      color.setHex(def.color).convertSRGBToLinear();
      const base = i * VERT_FLOATS;
      for (let v = 0; v < VERT_FLOATS; v += 3) {
        pos[base + v] = CUBE_POS[v] + ox;
        pos[base + v + 1] = CUBE_POS[v + 1] + oy;
        pos[base + v + 2] = CUBE_POS[v + 2] + oz;
        norm[base + v] = CUBE_NORM[v];
        norm[base + v + 1] = CUBE_NORM[v + 1];
        norm[base + v + 2] = CUBE_NORM[v + 2];
        col[base + v] = color.r;
        col[base + v + 1] = color.g;
        col[base + v + 2] = color.b;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return geo;
  }

  /** Leaves persistent visual rubble at a settled chunk's resting transform — one piece per voxel,
   *  at its rotated world position, so the pile looks just like the chunk that landed. */
  private depositRubble(c: Chunk): void {
    if (!this.onRubble) return;
    const t = c.body.translation();
    const r = c.body.rotation();
    _Q.set(r.x, r.y, r.z, r.w);
    for (let i = 0; i < c.voxels.length; i++) {
      const [vx, vy, vz] = c.voxels[i];
      // voxel offset from the body origin (spawn centroid), rotated into the resting pose
      _V.set((vx + 0.5) * VOXEL - c.cx, (vy + 0.5) * VOXEL - c.cy, (vz + 0.5) * VOXEL - c.cz);
      _V.applyQuaternion(_Q);
      this.onRubble(t.x + _V.x, t.y + _V.y, t.z + _V.z, r.x, r.y, r.z, r.w, c.materials[i]);
    }
  }

  private release(index: number): void {
    const c = this.chunks[index];
    this.physics.world.removeRigidBody(c.body);
    this.scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.chunks.splice(index, 1);
  }

  update(dt: number): void {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.age += dt;
      // detect rest by our own velocity threshold (Rapier's sleep is unreliable here)
      const lv = c.body.linvel();
      const av = c.body.angvel();
      const moving = (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z) > 0.5 ||
                     (av.x * av.x + av.y * av.y + av.z * av.z) > 0.6;
      if (moving) {
        c.sleep = 0;
      } else {
        c.sleep += dt;
      }
      // settle when at rest, or force it once too old (a wedged chunk would never rest otherwise)
      if ((!moving && c.sleep > SETTLE_AFTER_SLEEP) || c.age > CHUNK_MAX_AGE) {
        this.depositRubble(c); this.release(i); continue;
      }
      const t = c.body.translation();
      const r = c.body.rotation();
      c.mesh.position.set(t.x, t.y, t.z);
      c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
