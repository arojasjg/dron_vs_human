# Worklog — interior lights + flashlight + human melee

## Goal (user)
1. Dim interior lights in SOME buildings (not all); some flicker. + a flashlight (linterna) for the drone AND the human.
2. Human melee attack, with sound + animation.

## Design
- Pure: `meleeHit(ax..,dir, target.., range, minDot)` in weapons.ts (cone check); `flicker(t, seed)` in
  interiorLights.ts (fluorescent-ish intensity 0.15..1). Tested.
- Interior lights (`src/engine/interiorLights.ts`): from placedBuildings() → dim non-shadow PointLights inside a
  DETERMINISTIC subset (some buildings), a few flagged flicker; update(t) animates them. Built on rebuildWorld,
  updated each frame. Perf: ~8 lights, finite distance, NO shadows.
- Flashlight: a SpotLight following the local camera (both roles), toggled with F. Non-shadow (perf).
- Melee (human only): key V in combat → cooldown + cone damage (self-damage model, broadcast `melee`), swing
  sound + hit thud; remote avatar plays a rifle-butt swing (upper/rifle rotate ~0.35 s). audio.melee/meleeHit.

## Keys
- F = flashlight (universal; throw-crate moves to J). V = melee (humans, combat).

## Stage map / status
- [ ] A pure meleeHit + flicker + tests
- [ ] B interior lights (build from placedBuildings + per-frame flicker)
- [ ] C flashlight spotlight (follow camera + toggle)
- [ ] D melee (input + cone damage + broadcast + remote swing anim + sound)
- [ ] E verify (tsc+suite+adversarial) + browser eval (light count, spotlight, melee damage)

## Verify: npx tsc --noEmit · npx vitest run · browser eval
