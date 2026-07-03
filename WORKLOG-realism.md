# Worklog — weathering + trees + clouds (realism pass)

## Goal (user)
More varied buildings with signs/stains/old-paint/cracks/wear (ultra-realistic) + grass + trees + some clouds.

## State
- Grass ALREADY exists (game.ts buildGround: mottled-green subdivided plane). Signs/decoration/variety done last session.
- NEW work: per-voxel WEATHERING (grime/stains/wear/faded paint), TREES, CLOUDS.
- "More buildings" by COUNT = plot-grid change (coupled to SPAWNS/bases) → deferred; boost richness via trees+weathering instead.

## Design
- `src/world/weathering.ts` (NEW, pure): weatherMul(x,y,z) → deterministic brightness ~[0.45,1.1] (grime low-down,
  per-voxel wear noise, ~3% dark stains). Hash of position → stable across rebuilds + clients (no flicker/desync).
- mesher (voxelMesh.ts): setColorAt per greedy box (box centre → weatherMul) → InstancedMesh instanceColor modulates
  the material base colour. Per-BOX (coarser than per-voxel; greedy boxes) — flag.
- Clouds: drifting billboard sprites high in the sky (renderer or a fx module), soft cloud texture (procedural canvas).
- Trees: voxel trees (trunk + foliage blob) placed deterministically in street gaps, grounded, destructible.

## AESTHETIC CAVEAT
The WebGL canvas can't be screenshot in this env → I verify STRUCTURE by eval (instanceColor set + varied, N cloud
sprites in scene, N tree voxels grounded, weatherMul deterministic/bounded). Whether it "looks ultra realistic" is the user's call.

## Stages
- [ ] A weathering.ts pure + test; mesher applies it
- [ ] B clouds (drifting sprites)
- [ ] C trees (voxel, seeded, in buildDefaultScene)
- [ ] D verify (tsc+suite+adversarial) + eval (colours varied, clouds/trees present, no floaters)

## Verify: npx tsc --noEmit · npx vitest run · browser eval
