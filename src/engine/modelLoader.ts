import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

// Loads professional rigged + animated glTF/GLB characters (replacing the hand-built low-poly avatars)
// and hands out per-instance clones with their own AnimationMixer. One download is shared across every
// avatar of a kind; a failed load returns null so the caller falls back to its procedural model.

export interface ModelInstance {
  scene: THREE.Group;                              // a skinned clone, ready to add to the world
  mixer: THREE.AnimationMixer;                     // advance() it each frame
  actions: Map<string, THREE.AnimationAction>;     // one action per animation clip, keyed by clip name
  materials: THREE.MeshStandardMaterial[];         // this instance's OWN standard materials → tint without touching the shared cache
}

const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF | null>>();

function base(): string {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}

/** Loads (once, cached) the shared glTF. Resolves null on any error so callers can fall back. */
function loadGltf(url: string): Promise<GLTF | null> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new Promise<GLTF | null>((resolve) => {
      loader.load(base() + url, (g) => resolve(g), undefined, () => resolve(null));
    });
    gltfCache.set(url, p);
  }
  return p;
}

/** A fresh animatable INSTANCE of the model (own skeleton clone + mixer + named actions), or null. */
export async function instanceModel(url: string): Promise<ModelInstance | null> {
  const gltf = await loadGltf(url);
  if (!gltf) return null;
  const scene = cloneSkinned(gltf.scene) as THREE.Group;
  // cloneSkinned shares geometry AND materials by reference, so tinting a clone would tint EVERY instance.
  // Clone each mesh's material(s) per instance and collect the standard ones so the caller can recolour this
  // avatar's team/class accent (emissive) in isolation — a cheap per-instance material clone, geometry stays shared.
  const materials: THREE.MeshStandardMaterial[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true; // so an avatar standing in building shade is grounded, not pasted on
    mesh.frustumCulled = false;
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      mesh.material = mat.map((m) => { const c = m.clone(); if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) materials.push(c as THREE.MeshStandardMaterial); return c; });
    } else if (mat) {
      const c = mat.clone(); mesh.material = c;
      if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) materials.push(c as THREE.MeshStandardMaterial);
    }
  });
  const mixer = new THREE.AnimationMixer(scene);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
  return { scene, mixer, actions, materials };
}

/** Case-insensitive lookup of an action by any of the given clip-name candidates (models vary in naming). */
export function pickAction(actions: Map<string, THREE.AnimationAction>, ...names: string[]): THREE.AnimationAction | null {
  for (const n of names) {
    for (const [key, act] of actions) if (key.toLowerCase() === n.toLowerCase()) return act;
  }
  for (const n of names) {
    for (const [key, act] of actions) if (key.toLowerCase().includes(n.toLowerCase())) return act;
  }
  return null;
}
