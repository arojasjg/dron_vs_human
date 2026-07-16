// glTF avatar model registry + the pure LOD selector. Kept three.js-free so the config and the
// "which bots get the expensive skinned model" decision unit-test without a renderer.
import type { Role, SoldierClass, DroneClass } from "./roles";
import type { AiKind } from "./ai";

export interface AvatarModelConfig {
  url: string;       // path under public/ (loaded via instanceModel)
  scale: number;     // uniform scale applied to the loaded scene
  yOffset: number;   // vertical offset so the model sits right on the avatar group
  rot: number;       // Y rotation so it faces the group's forward
  clips: { idle: string; walk?: string; run?: string }; // clip-name candidates (pickAction is fuzzy/case-insensitive)
}

// A DISTINCT CC0 model per class/archetype so no two classes look the same. All non-skinned drones (→ cheap to
// instance for the swarm); soldiers are peers-only (few) so a skinned model is fine. scale/yOffset are in-world
// tuning (the lobby preview auto-frames by bbox, so it reads any of these correctly regardless).
const drone = (url: string, scale = 1, yOffset = 0): AvatarModelConfig =>
  ({ url, scale, yOffset, rot: Math.PI, clips: { idle: "Idle", walk: "Walk", run: "Run" } });
const soldier = (url: string, scale = 1, yOffset = -1.5): AvatarModelConfig =>
  ({ url, scale, yOffset, rot: Math.PI, clips: { idle: "Idle", walk: "Walk", run: "Run" } });

/** One distinct drone model per drone class. */
export const DRONE_CLASS_MODEL: Record<DroneClass, AvatarModelConfig> = {
  assault:     drone("models/units/drone_basic.glb"),
  interceptor: drone("models/units/drone_little.glb"),
  armor:       drone("models/units/drone_predator.glb"),
  artillery:   drone("models/units/drone_orb.glb"),
};
/** One distinct soldier model per soldier class. */
export const SOLDIER_CLASS_MODEL: Record<SoldierClass, AvatarModelConfig> = {
  assault:  soldier("models/units/sol_rifleman.glb"),
  scout:    soldier("models/units/sol_scout.glb"),
  heavy:    soldier("models/units/sol_swat.glb"),
  marksman: soldier("models/units/sol_sniper.glb"),
};
/** One distinct drone model per AI archetype → the enemy swarm reads as a varied force, not one clone. */
export const KIND_MODEL: Record<AiKind, AvatarModelConfig> = {
  chaser:   drone("models/units/drone_little.glb"),
  gunner:   drone("models/units/drone_basic.glb"),
  diver:    drone("models/units/drone_antigrav.glb"),
  tank:     drone("models/units/drone_predator.glb"),
  kamikaze: drone("models/units/drone_stinger.glb"),
  support:  drone("models/units/drone_orb.glb"),
};

/** The model for a player's role+class, falling back to that side's "assault" for an unknown class. Pure. */
export function unitModel(role: Role, cls: string): AvatarModelConfig {
  if (role === "drone") return DRONE_CLASS_MODEL[cls as DroneClass] ?? DRONE_CLASS_MODEL.assault;
  return SOLDIER_CLASS_MODEL[cls as SoldierClass] ?? SOLDIER_CLASS_MODEL.assault;
}

/** The on-disk glTF avatars. Soldiers keep the rigged Soldier.glb; the drone preview uses the CC0
 *  enemy-flying quadcopter (a real drone reads better than a walking robot). Scale/offset browser-tuned. */
export const MODEL_CONFIGS: Record<"soldier" | "robot", AvatarModelConfig> = {
  soldier: { url: "models/Soldier.glb", scale: 1.0, yOffset: -1.5, rot: Math.PI, clips: { idle: "Idle", walk: "Walk", run: "Run" } },
  robot: { url: "models/drone/enemy-flying.glb", scale: 1.6, yOffset: -0.4, rot: Math.PI, clips: { idle: "Idle", walk: "Walk", run: "Run" } },
};

/** Which bots get the EXPENSIVE skinned glTF this frame: only the up-to-`n` NEAREST bots within `r` metres of
 *  the camera. Everything else stays the cheap procedural quadcopter, so the skinned-mesh cost is bounded no
 *  matter how big the wave grows. Deterministic (distance then id tiebreak). Pure. */
export function selectGltfBots(
  camX: number, camZ: number, bots: readonly { id: number; x: number; z: number }[], n = 12, r = 40,
): Set<number> {
  const near: { id: number; d: number }[] = [];
  const r2 = r * r;
  for (const b of bots) {
    const dx = b.x - camX, dz = b.z - camZ, d2 = dx * dx + dz * dz;
    if (d2 <= r2) near.push({ id: b.id, d: d2 });
  }
  near.sort((a, b) => a.d - b.d || a.id - b.id); // nearest first, id tiebreak → deterministic, no thrash on ties
  const out = new Set<number>();
  for (let i = 0; i < Math.min(n, near.length); i++) out.add(near[i].id);
  return out;
}
