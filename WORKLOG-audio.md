# Worklog — procedural game audio (Web Audio)

## Goal (user)
Generate realistic sounds (procedurally — no external assets/licences) and add sound to ALL game actions.

## Design
- `src/fx/soundParams.ts` (NEW, pure): per-action synth params — WEAPON_SFX, explosionParams(power),
  IMPACT_SFX per material, distanceGain(dist). Tested.
- `src/fx/audio.ts` (NEW): `GameAudio` class over ONE AudioContext (also serves the keep-alive), master
  gain, resume-on-gesture. Synth helpers (noiseBurst, tone) compose each SFX: shot(weapon), explosion,
  impact(material), voxelBreak, hit, death, respawn, weaponSwitch, emptyClick, place/erase, footstep(run),
  jump, land, uiClick, and a continuous droneRotor(speed) loop. Spatial events attenuate by distanceGain.
- Wire into game.ts (fire/explode/impact/break/damage/death/respawn/switch/empty/place/erase/ui),
  walker.ts (footsteps via walk phase, jump, land), player.ts (rotor level from speed).
- Replace keepAwakeAudio's throwaway context with GameAudio's (a live SFX context already keeps the tab awake).

## Stage map / status
- [ ] A soundParams.ts pure + tests
- [ ] B audio.ts GameAudio (synth + rotor + spatial + keep-alive/resume)
- [ ] C wire game/walker/player action sites
- [ ] D verify (tsc+suite+adversarial) + browser (OfflineAudioContext non-zero render; live triggers no-throw)

## Verify: npx tsc --noEmit · npx vitest run · browser eval (render a shot to OfflineAudioContext → non-zero RMS)
