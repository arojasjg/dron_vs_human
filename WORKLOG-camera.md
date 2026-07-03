# Worklog — Drone/human camera feel + filters + global lighting

## Goal (user, 3 items)
1. Drone moves like a drone (limitations + inertia + banking) + a drone FPV camera with body-cam-style effects/filter.
2. Humans use a camera with visual effects + body-cam filters (vignette, grain, REC, head-bob).
3. Improve the global lighting.

## Design
- `src/engine/cameraFeel.ts` (NEW, pure): droneBank(rightVel,max), hoverSway(t), speedFov(base,boost,spd,max),
  headBob(phase,spd,max). Camera effects via camera roll/FOV/position offsets (aim-safe: roll around forward
  doesn't change look dir). No post-processing pipeline — overlay is DOM/CSS.
- `src/fx/cameraFx.ts` (NEW): full-screen `#camfx` overlay, two skins — drone FPV (cyan tint, reticle, telemetry
  brackets, scanlines) and human body-cam (vignette, film grain, ● REC + timestamp, warm grade). setRole/update.
- Lighting: renderer.ts — stronger/warmer sun, better fill (hemisphere), exposure/tone, richer sky+fog.

## Stage map / status
- [ ] A cameraFeel.ts pure + tests
- [ ] B player.ts: banking roll + hover sway + speed FOV (drone limitations/feel)
- [ ] C walker.ts: head-bob (phase by distance)
- [ ] D cameraFx.ts overlay + wire in game.ts (role skin + telemetry)
- [ ] E renderer.ts global lighting
- [ ] F verify (tsc+suite+adversarial) + browser screenshots + deliver

## Verify: npx tsc --noEmit · npx vitest run · in-browser screenshots (drone FPV, human body-cam, lighting)
