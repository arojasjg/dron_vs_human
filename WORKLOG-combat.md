# Worklog — Team combat overhaul (weapons / ammo / battery / HUD / models / lobby)

Multi-session. Re-read before any continuation.

## Goal (user, 5 items)
1. Enormously improve the 3D drone + soldier models.
2. Team weapons — DRONE: machine-gun, few grenades, kamikaze self-explosion. HUMAN: machine-gun,
   shotgun, explosive grenade-launcher, net (catch a drone).
3. Both with limited AMMO, recharged at the team base.
4. Drone BATTERY: drains faster the more/faster it moves; at 0 it falls and dies.
5. Start/lobby UI (join by code) + combat HUD: weapon+ammo (mag/total), own health, teammates' health, battery.

## Design (data-driven)
- `src/net/weapons.ts` (NEW, pure): `Weapon` type, `WEAPONS` specs (fire kind, cooldown, mag, reserve),
  `roleLoadout(role)`, pure `tryFire(ammo, magSize)` + `refill(spec)`. Battery: pure `batteryDrain(speed, dt)`.
- Bases: distance from player to `OBJECTIVE_SITES[role==="drone"?0:1]` centre → recharge ammo+battery.
- Ammo/battery are LOCAL-authority (like hp); broadcast on the `state` msg only if peers must see.

## Stage map / status
- [ ] A weapons.ts (pure loadout + ammo + battery) + tests  ← current
- [ ] B game.ts wiring: loadout-gated switch, ammo consume/block, near-base recharge, battery drain+death, fire verbs
- [ ] C projectile.ts: launchShotgun (spread), launchNet
- [ ] D hud.ts: setWeapon(mag,reserve) + setBattery + setTeam panels
- [ ] E remoteDrones.ts: improved models + peers() + store hp/role
- [ ] F start/lobby screen polish (generate code)
- [ ] G verify (tsc+suite+adversarial) + falsify + deliver

## Verification commands
`npx tsc --noEmit` · `npx vitest run`

## Next concrete action
Write src/net/weapons.ts (pure) + tests/weapons.test.ts, run them.

## STATUS (session 2 end)
DONE+VERIFIED (browser, dvh): weapons.ts (6 tests), loadout weapon-switch (1/2/3), ammo consume/block,
HUD (icon bar + battery + K/D/A + teammates), improved models, K/D/A + kill-attribution, respawn+resupply,
battery drain (dvh only), fixed "no dispara" (was a broken build: fireWeapon referenced before defined).
tsc clean, 134 tests. Adversarial review: 0 grid-desync.
NEXT (deferred, prioritised): (1) bullets must damage PLAYERS (mg/shotgun are combat-inert — needs a
player-hitbox/hitscan + phit broadcast); (2) real NET catch/immobilise; (3) start/lobby code-generate;
(4) combat help text (still shows sandbox keys); (5) self-kill scoring for kamikaze (design).
