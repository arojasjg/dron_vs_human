// glTF avatar model registry + the pure LOD selector. Kept three.js-free so the config and the
// "which bots get the expensive skinned model" decision unit-test without a renderer.

export interface AvatarModelConfig {
  url: string;       // path under public/ (loaded via instanceModel)
  scale: number;     // uniform scale applied to the loaded scene
  yOffset: number;   // vertical offset so the model sits right on the avatar group
  rot: number;       // Y rotation so it faces the group's forward
  clips: { idle: string; walk?: string; run?: string }; // clip-name candidates (pickAction is fuzzy/case-insensitive)
}

/** The on-disk glTF avatars. Soldiers keep the rigged Soldier.glb; drones (preview + near-LOD) use the
 *  animated RobotExpressive.glb. Scale/offset are eyeballed and browser-tuned. */
export const MODEL_CONFIGS: Record<"soldier" | "robot", AvatarModelConfig> = {
  soldier: { url: "models/Soldier.glb", scale: 1.0, yOffset: -1.5, rot: Math.PI, clips: { idle: "Idle", walk: "Walk", run: "Run" } },
  robot: { url: "models/RobotExpressive.glb", scale: 0.3, yOffset: -0.35, rot: Math.PI, clips: { idle: "Idle", walk: "Walking", run: "Running" } },
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
