# Worklog — collapse fix + building variety + 2 bases per team

Three bundled requests. #1 DONE this session; #2 and #3 staged for continuation.

## #1 Structural collapse (buildings float) — DONE ✅
- Reproduce-first DISPROVED "solver broken": findUnsupported/collapseStep WORK (disconnected storey drops 231/231).
- Root cause: CELL_OVERHANG=6 cells ≈ 12 m lateral cantilever budget → blasted overhangs stayed "connected".
- Fix: CELL_OVERHANG 6→2 (game.ts). Measured: intact city 0 false-floaters at ≥2 (only 2 at 1). Stairs/fire-escapes hold.
- Tests: tests/collapse.test.ts (intact across 6 seeds + 9 building configs; disconnection falls; cantilever falls at 2 not 6). Browser: collapse fires end-to-end (+8..128 voxels beyond the blast). Adversarial: clean — determinism byte-identical at any pacing.
- OPTIONAL future: true WEIGHT-based load model (heavy masses on thin support fall) — current is geometric overhang (approximates "little support→falls"). Also a networked collapse-convergence test (sync covers carve, not collapse).

## #2 More dynamic buildings (signs, edges, balconies, subtle variety) — TODO
- prefabs.ts buildBuilding: add seeded per-building decoration — a colored sign/parapet band, edge trim/cornices, balconies on some upper floors, varied window rhythm, awnings. Keep seeded-deterministic (rand()) so clients match. Add to building.test.ts (variety present, still grounded, no false floaters at overhang 2).

## #3 Two bases per team + HP + win — TODO
- prefabs.ts buildObjectives: place 2 drone bases (rooftops) + 2 human bases (interiors) = 4 sites (currently 1+1). OBJECTIVE_SITES → 4 entries with team tags.
- HP per base: currently "alive if any voxel remains". Add an HP model (e.g., count surviving core voxels vs initial → hp%; base destroyed when core voxels < threshold). Show base HP on the HUD.
- Win: a team wins when BOTH enemy bases are destroyed (or the kill limit). checkMatchWin over the 4 sites. HUD scoreboard shows 2 objectives per team.

## Verify: npx tsc --noEmit · npx vitest run · browser eval
