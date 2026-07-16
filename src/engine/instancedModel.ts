import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Loads a static (non-skinned) glTF prop and reduces it to per-material merged parts, so a whole set of
// identical props renders as ONE InstancedMesh per material — draw calls = material count, INDEPENDENT of
// how many are placed. Used for ground pickups (ammo crate, medkit) that scatter by the dozen and must not
// cost a draw call each. A failed load resolves null → the caller keeps its procedural fallback.

export interface InstancedPart { geometry: THREE.BufferGeometry; material: THREE.Material; }

const loader = new GLTFLoader();
const cache = new Map<string, Promise<InstancedPart[] | null>>();

function base(): string {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}

/** Pure: the uniform scale + translation that fits a bbox to `targetH` metres tall, base at y=0, centred in
 *  XZ. `targetH<=0` → identity (keep the model's own size). Exposed for unit tests. */
export function fitTransform(
  min: readonly [number, number, number], max: readonly [number, number, number], targetH: number,
): { scale: number; dx: number; dy: number; dz: number } {
  const h = max[1] - min[1];
  const scale = targetH > 0 && h > 1e-6 ? targetH / h : 1;
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  return { scale, dx: -cx * scale, dy: -min[1] * scale, dz: -cz * scale };
}

/** Strip a geometry to a merge-compatible {position, normal, uv} set (non-indexed so mixed layouts merge
 *  cleanly), adding a zero UV where a model has none (untextured medkit/bandage). */
function harmonize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const keep = new Set(["position", "normal", "uv"]);
  for (const name of Object.keys(g.attributes)) if (!keep.has(name)) g.deleteAttribute(name);
  g.morphAttributes = {}; // toNonIndexed/clone keep morphs; a group with mixed morphs would fail mergeGeometries → drop them
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

async function build(url: string, targetH: number): Promise<InstancedPart[] | null> {
  const gltf = await new Promise<GLTF | null>((resolve) => {
    loader.load(base() + url, (g) => resolve(g), undefined, () => resolve(null));
  });
  if (!gltf) return null;
  gltf.scene.updateMatrixWorld(true);
  // glTF gives one THREE.Mesh per primitive (single material each) → group geometries by material and merge.
  const groups = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material) return;
    const mat = mesh.material;
    const baked = harmonize(mesh.geometry);
    baked.applyMatrix4(mesh.matrixWorld); // bake node transforms so model scale/offset is real
    const key = mat.uuid;
    const grp = groups.get(key) ?? { material: mat, geos: [] };
    grp.geos.push(baked);
    groups.set(key, grp);
  });
  if (groups.size === 0) return null;
  const parts: InstancedPart[] = [];
  for (const { material, geos } of groups.values()) {
    const merged = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) ?? geos[0]);
    parts.push({ geometry: merged, material: material.clone() }); // clone the material so we never mutate the shared cache
  }
  if (targetH > 0) {
    const box = new THREE.Box3();
    for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox!); }
    const t = fitTransform([box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z], targetH);
    const m = new THREE.Matrix4().makeScale(t.scale, t.scale, t.scale).premultiply(new THREE.Matrix4().makeTranslation(t.dx, t.dy, t.dz));
    for (const p of parts) p.geometry.applyMatrix4(m);
  }
  return parts;
}

/** Load (once, cached per url+targetH) a static glTF as merged per-material parts. `targetH` fits the model
 *  to that height in metres with its base on the ground; 0 keeps the native size. Null on any error. */
export function loadInstancedModel(url: string, targetH = 0): Promise<InstancedPart[] | null> {
  const key = `${url}|${targetH}`;
  let p = cache.get(key);
  if (!p) { p = build(url, targetH); cache.set(key, p); }
  return p;
}
