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
  scene.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true; // so a soldier standing in building shade is grounded, not pasted on
    o.frustumCulled = false;
    // full sky IBL over-brightens skinned models; ease it so they sit in the scene's light
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
    for (const m of Array.isArray(mat) ? mat : [mat]) if (m && "envMapIntensity" in m) m.envMapIntensity = 0.7;
  });
  const mixer = new THREE.AnimationMixer(scene);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
  return { scene, mixer, actions };
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
