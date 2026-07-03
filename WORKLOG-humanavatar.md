# Worklog — fix the human player avatar

## Goal (user, 4 items)
1. Human avatar FLOATS (feet off the ground) — placed at the eye position but the model is centred at the
   body centre → feet at -0.9 instead of -1.45 → floats ~0.55 m. FIX: drop the human avatar Y by ~0.55.
2. Mouse-look rotates the WHOLE body — it gets the camera quaternion (yaw+pitch). Should be BODY=yaw only
   (upright), HEAD+ARMS+WEAPON=pitch. FIX: broadcast yaw+pitch; body group yaws, an `upper` sub-group pitches.
3. Walk/run animation — legs (and a bob) should cycle when moving. FIX: `legL`/`legR` hip-pivot groups swung
   by a walk phase derived from the interpolated position delta (moving vs idle).
4. Crouch + prone — new stances. FIX: Walker stance (Ctrl=crouch hold, Z=prone toggle) → lower eye + slower
   speed + broadcast `st`; remote avatar ducks/lies via a stance pose.

## Design
- `src/net/humanPose.ts` (NEW, pure): STANCES table (eye, speedMul, avatarDrop, legBend, bodyLean),
  legSwing(phase, speed, max). Tested.
- State msg gains `ry` (yaw), `rp` (pitch), `st` (stance). Walker/Player expose aimYaw/aimPitch/stance.
- remoteDrones human REBUILT: outer group (pos + -drop, yaw) → body parts + `upper`(pitch pivot ~0.42) +
  `legL`/`legR`(hip pivot ~-0.2). update() applies yaw/pitch/walk/stance. Drone path unchanged (quaternion).

## Stage map / status
- [ ] A humanPose.ts pure + tests
- [ ] B remoteDrones: rebuild human hierarchy + floating offset + yaw/pitch/walk/stance in update
- [ ] C Walker stance (crouch/prone input + eye/speed) + aimYaw/aimPitch/stance getters (Walker+Player)
- [ ] D game.ts broadcast ry/rp/st + onNet upsert passes them
- [ ] E verify (tsc+suite+adversarial) + browser eval

## Verify: npx tsc --noEmit · npx vitest run · browser eval (feet Y, body yaw-only, leg swing, stance)
