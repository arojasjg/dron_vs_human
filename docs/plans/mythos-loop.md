# Mythos Loop — Mejora continua de "Dron vs Human"

> Estado durable del loop autoperpetuante. Cada ciclo lee y actualiza este archivo.
> Invocado: 2026-07-18. Modo: MYTHOS/ULTRA. Ejecutor de fixes: **Fable 5** (degrada a Opus si no disponible).

## Done-contract (checks ejecutables — el loop nunca los rompe)

- `npx tsc --noEmit` → exit 0  (baseline: PASA)
- `npx vitest run` → exit 0    (baseline: PASA, 72 archivos de test)
- Cada mejora: diff mínimo + test nuevo/extendido que la cubra + review adversarial de otra gama de modelo.
- Check visual best-effort en Chrome cuando el cambio sea visual/jugable.
- Rama de trabajo: `mythos/loop-improvements`. Commit local por mejora. **NUNCA push sin OK del usuario.**

## Política del loop (decisiones del usuario)

1. **Prioridad:** correctness/crashes → gameplay (IA drones, armas, PvP) → rendimiento → visual/modelos/anim → lobby/pantallas/UX.
2. **Duración:** ilimitado hasta que el usuario diga "para"/"detén el loop".
3. **Rama:** `mythos/loop-improvements`, commit local por mejora verificada, sin push.
4. **Verificación:** gate headless (vitest + tsc + review adversarial) + Chrome best-effort para lo visual.

## Procedimiento por ciclo

1. Leer este archivo (backlog + último ciclo).
2. Asegurar rama `mythos/loop-improvements`.
3. Tomar el ítem TOP no bloqueado (respetando prioridad).
4. Delegar el fix a un agente **Fable** (`model: fable`): file:line exacto + dirección del fix +
   contrato "tests verdes, añade/extiende test, diff mínimo, estilo del entorno, cero comentarios salvo WHY no obvio".
5. **Gate** (todo debe pasar; si no, revertir el ítem y marcar BLOCKED/retry):
   tsc 0 · vitest 0 · review adversarial (gama distinta al ejecutor) · Chrome best-effort si aplica.
6. Commit local: `git commit -m "<área>: <qué> (mythos loop ciclo N)"`.
7. Actualizar este archivo: marcar ítem hecho (hash), añadir nuevos hallazgos, incrementar contador.
8. Emitir status corto al usuario.
9. `ScheduleWakeup` para el siguiente ciclo (salvo que el usuario haya dicho "para").

**Guard anti-thrash (hard rule 5):** si un ítem falla el gate 2×, marcar BLOCKED con problema limpio y pasar al siguiente. No insistir.

---

## Backlog priorizado (cola de trabajo)

Leyenda: `[ ]` pendiente · `[~]` en curso · `[x]` hecho (hash) · `[B]` bloqueado.
IDs por cluster: **NET** (red/PvP), **CBT** (combate), **RND** (render/perf/modelos/anim), **UX** (game-loop/UI).

### P0 — Correctness / crashes / hit-registration (primero)

- [ ] CBT-C1 · IA "apunta" pero el disparo es `Math.random()<0.55` sin raycast — `src/game.ts:657-668` (`aiShoot`). Hit-test el rayo emitido contra la esfera del objetivo (reusar `rayHitsSphere`), daño con falloff, cono de miss desde `spread(wave)`. **Núcleo de "la IA no funciona".**
- [ ] CBT-C2 · Asimetría host/peer: peer recibe daño incondicional, host solo 55% — `src/game.ts:664` vs `666`. Unificar modelo de hit (mismo ray test para ambos).
- [ ] CBT-H1 · Daño de balas del jugador vs bots capado a 30 m mientras el tracer vuela ~180 m (impactos visibles = 0 daño) — `src/game.ts:1008`. Rango hip-fire por arma en `WeaponSpec`, alineado al tracer.
- [ ] UX-M3 · `beginMatch` no limpia estado transitorio (miniDrones, scanPings, lockId, firing, ads…) — `src/game.ts:514-542`. `resetTransientCombatState()`.
- [ ] **NET-C1** · **(bug corona PvP)** DvH mezcla eje rol(drone/human) y eje equipo(Rojo/Azul) → scoring/win/spawn/FF discrepan; un match all-human puede "ganarlo los Drones" — `src/game.ts:472-473,525,1265,1270,1284-1290,1906`, `src/net/objectives.ts:44-50`. Colapsar a UN eje autoritativo: en dvh derivar team del rol (drones=team0, humans=team1), quitar picker Rojo/Azul en dvh; FF/spawn/radar/hit/kill/objetivo/scoreboard leen el mismo campo.
- [ ] NET-C2 · Late-join imposible; el que entra a match en curso queda atascado en lobby — `src/game.ts:1120,1128,1137-1139`, `server/relay.mjs:65-70`. Host manda `begin` dirigido + `needsync` al ver un `join` en `playing` (o relay persiste último `begin` por sala).
- [ ] NET-H3 · Sin lag-comp/autoridad → "le di y no pasa nada" — `src/game.ts:1326-1336,1312,1340-1345`, `remoteDrones.ts:259-265`. Timestamp de disparos + rewind de peers en la víctima (o autoridad al tirador con sanity-check); ensanchar hitbox más allá de la esfera r=1.0 en el ojo.
- [ ] NET-H4 · Sin balance de equipos ni ready-up; host arranca unilateral; auto-balance muerto — `src/net/lobby.ts:45`, `src/game.ts:483,1233`. Ready-gate + mínimo por equipo + alimentar roster real a `assignRole`. (⇄ UX-H2)
- [ ] NET-M1 · Muertes ambientales/suicidio puntúan para el enemigo — `src/game.ts:1430-1440,2610,2433`. Solo contar kill con killer/assist válido en ventana; taggear self/environment como no-scoring.
- [ ] NET-M2 · Win DvH deshabilitado en mapas chicos (<4 sitios) también salta kill-limit → match sin fin — `src/build/prefabs.ts:940`, `src/game.ts:1278`. Garantizar 4 sitios o fallback a kill-limit.
- [ ] NET-M3 · Código de sala erróneo crea sala vacía y el joiner se vuelve "host" — `server/relay.mjs:58-60`, `src/game.ts:494,509`. Relay distingue join-existente vs crear; cliente muestra "sala vacía/esperando".
- [ ] NET-H1 · Reconexión inexistente + id nuevo en cada connect (pierde K/D, equipo, spawn) — `src/net/net.ts:30`, `server/relay.mjs:45,58`. Auto-reconnect backoff + token de cliente para restaurar id/team/score.
- [ ] NET-L1 · Relay confía todos los campos, sin rate/size limit ni cap de sala (spoof de scores, flood) — `server/relay.mjs:65-70`. Validar tipos, cap de sala, rate-limit.

### P1 — Gameplay feel (IA drones · armas · PvP)

- [ ] CBT-C3 · Armas hitscan sin recoil/spread/bloom/falloff → láser a 220 m — `src/game.ts:2349-2356`, `src/net/weapons.ts:98`. Recoil por arma + bloom acumulado aplicado a la dirección real + falloff MG/LMG.
- [ ] CBT-H2 · Sin pathfinding real; "trepar" deja bots varados en techos/muros — `src/net/ai.ts:490-517`. Navgrid/flow-field grueso alrededor de footprints para rutear lateral.
- [ ] CBT-H3 · Daño IA es magic `4` plano sin arquetipo/distancia/wave — `src/game.ts:664,666`. Daño en `ARCHETYPES` + escala por wave + falloff.
- [ ] CBT-H4 · Recargas instantáneas sin tiempo/lockout → sin tensión — `src/net/weapons.ts:114-129`, `src/game.ts:1081-1092`. Duración de recarga que bloquea disparo + anim/sonido.
- [ ] CBT-H5 · Sin niveles de dificultad; solo rampa "BRUTAL" — `src/net/ai.ts:75-84`. Multiplicador de dificultad → wave size, fire-rate, precisión, daño, cadencia.
- [ ] CBT-H6 · Peers nunca disparan evasión IA (no se envía aim de peers) — `src/game.ts:581` vs `remoteDrones.ts:216-226`. Difundir aim dir de cada soldado.
- [ ] CBT-H7 · Movimiento orbit-strafe predecible + evasión débil — `src/net/ai.ts:448-450,479`. Burst-strafes/jukes de altitud, break-off, cover-seeking.
- [ ] CBT-M1 · Sin hitzones/headshots → TTK plano — `src/net/weapons.ts:72-82`. Sub-esfera de cabeza con multiplicador + hit-marker distinto.
- [ ] CBT-M2 · Arquetipos de bot invisibles; bots dañados sin vida — `src/game.ts:627`. Difundir hp/maxHp + tag de arquetipo; tinte/escala + barra al dañarse.
- [ ] CBT-M4 · Modelo dual de bala (hitscan instantáneo + tracer físico) → travel-time falso — `projectile.ts:147-169` + `game.ts:2350`. Elegir un modelo.
- [ ] CBT-M3 · Kamikaze IA power `1.4` vs jugador `1400` (gap 1000×) — `src/game.ts:682`. Verificar carve power.
- [ ] CBT-M5 · Bots pueden disparar sin telegrafía al primer peek — `src/net/ai.ts:345,528`. Delay de adquisición.
- [ ] CBT-M6 · Grenade/kamikaze IA daño magic `30` sin falloff — `src/game.ts:686-687`. Escala por distancia.
- [ ] CBT-M7 · Spawn en anillo determinista — `src/net/ai.ts:339`. Jitter con rng sembrado.

### P2 — Rendimiento (stutters)

- [ ] RND-C1 · Stall de compilación de shader al primer render de cada modelo async (los picos ~157 ms) — `modelLoader.ts:36-62`, `remoteDrones.ts:170-182`, `viewmodel.ts:81-87`, `baseModels.ts:27-40`. `compileAsync`/pre-warm de avatar/arma/HQ antes de entrar a escena.
- [ ] RND-C2 · Swarm ~30 draws por bot, sin instancing cross-bot — `remoteDrones.ts:331-364`, `game.ts:627`. Fusionar a 1 mesh o InstancedMesh por parte; conectar `selectGltfBots` LOD.
- [ ] RND-H1 · Auto-downgrade de preset = recompile completo (~1 s freeze) — `game.ts:1561-1595`. Togglear uniforms/defines en vez de swap de materiales; o compileAsync.
- [ ] RND-H2 · Dynamic-res `setPixelRatio` realoca framebuffer mid-frame — `renderer.ts:93-99`, `game.ts:2939-2951`. Histéresis más ancha + escalas discretas + realoc en frame boundary.
- [ ] RND-H3 · Segundo render de escena completa al mirar por mira — `renderer.ts:195-224`, `game.ts:3030`. Mira a menor res, far plane, reusar depth, saltar partículas.
- [ ] RND-L3 · (Re)build de ~1.5M vóxeles síncrono en main thread (~700 ms freeze) al cargar/reiniciar — `game.ts:369,1773,1883`. Streamear el mesh inicial (usar `streamMeshes`/`rebuildDirty`).
- [ ] RND-GLTF · GLTFLoader sin DRACO/meshopt/KTX2 → parse sin comprimir en main thread — `modelLoader.ts:16`, `instancedModel.ts:12`. Adjuntar decoders worker-backed.
- [ ] RND-M-part · Capa de puntos dibuja el buffer completo (262k) mientras haya partículas vivas — `gpuParticles.ts:295-297,349`. Compactar a draw range denso o bajar texSize en GPU débil.

### P3 — Visual / modelos / animaciones

- [ ] RND-H4 · Modelos por-clase son dead code en juego; todo peer es idéntico ("malos modelos 3d") — `avatarModels.ts:22-44` vs `remoteDrones.ts:161-163`. Rutar `unitModel(role,cls)` + `selectGltfBots` a upsert/loadHumanModel.
- [ ] RND-V1 · Sin IBL/env map → PBR plano, metales casi negros (mayor driver de "visual pobre") — `renderer.ts:44-48`. Bake de PMREM pequeño del cielo → `scene.environment`.
- [ ] RND-A1 · Soldado riggeado pierde aim-pitch y pose de stance (nunca mira arriba/abajo ni se agacha visiblemente) — `remoteDrones.ts:168-183,273-281`. Aplicar pitch a hueso de cuello/espina; bajar mount para crouch/prone.
- [ ] RND-A2 · Drones sin orientación/facing (todos miran +Z deslizando de lado) — `game.ts:627`, `remoteDrones.ts:264-266`. Orientar hacia velocidad + banking en giros.
- [ ] RND-A3 · Solo 3 estados de anim, melee invisible en modelo riggeado — `remoteDrones.ts:287-299`. Clips aim/fire/melee/death o capas aditivas de torso.
- [ ] RND-A4 · Walk procedural = seno crudo sin foot-planting — `humanPose.ts:25-29`. Knee bend + foot-lock/plant + easing.
- [ ] RND-V2 · Sombras duras low-res short-range (PCF 1024, 35 m) — `renderer.ts:30,56,62-66`. PCFSoftShadowMap + mapa mayor/cascada.
- [ ] RND-V3 · Post-proceso solo bloom y solo alto; sin AO/FXAA en medio/bajo — `renderer.ts:103-135`. SSAO barato + FXAA fallback.
- [ ] RND-V4 · Viewmodels Kenney chocan con la ciudad voxel; materiales plástico sin mapas — `viewmodel.ts:16-34,54-62`. Set PBR texturizado consistente.

### P4 — Lobby / pantallas / UX / opciones

- [ ] UX-C1 · Sin pausa / menú in-game (Esc solo suelta el ratón) — `input.ts:37-39`, `game.ts:2770-2810`. Estado de pausa que congela sim + overlay Resume/Settings/Leave. **Mayor gap "no es juego completo".**
- [ ] UX-C2 · "Salir"/"Menú"/restart hacen `location.reload()` (pantalla negra multi-segundo) — `game.ts:385,439,493-505`. Transición real de vuelta a menú sin reload.
- [ ] UX-C3 · Ayuda equivocada en combate (muestra controles de sandbox) — `hud.ts:62-73`, `game.ts:2783`. HELP por modo con keybinds reales de combate.
- [ ] UX-C4 · Sin sensibilidad de ratón ni rebinding — `player.ts:7`, `walker.ts:11`, `settings.ts:7-12`. Sección `controls` (sens, invert-Y, FOV) + mapa de keybinds.
- [ ] UX-H1 · Menú de inicio pobre (2 botones + código) — `hud.ts:994-1004,452-463`. Settings, How-to-Play, Solo/Practice.
- [ ] UX-H2 · Lobby sin ready-up, sin mínimo de jugadores, sin balance de equipos — `game.ts:483-487`. Ready por jugador + checks + conteo Rojo/Azul.
- [ ] UX-H3 · Sin scoreboard completo (TAB = zoom minimapa) — `game.ts:2771`, `hud.ts:357-368`. Overlay scoreboard ambos equipos K/D/A.
- [ ] UX-H4 · Pantalla game-over mínima/genérica — `hud.ts:278-311`. Results dedicado con stats por jugador, MVP, precisión.
- [ ] UX-H5 · Sin loadout/deploy; clase fija todo el match — `game.ts:526-527,1369-1375`. Cambio de clase al morir/respawn.
- [ ] UX-H6 · Sin estado de conexión de red en UI — `game.ts:430`. Connecting/Connected/Lost.
- [ ] UX-H7 · Artefactos de dev en vista del jugador (link "Demo WebGPU", panel de stats) — `index.html:24-27`, `hud.ts:616-623`. Gatear tras `?perf`/debug.
- [ ] UX-H8 · Interacción solo implícita; sin tecla/prompt de "usar" — `game.ts:2570-2600`, `walker.ts:203-214`. Tecla interact + framework de prompt.
- [ ] UX-H9 · `game.ts` = god object 3195 líneas — `src/game.ts`. Extraer NetRouter, AiHost, WeaponsController, ScreenFlow, PerfProfiler. (Refactor grande — escalonar.)
- [ ] UX-M1 · Acciones del jugador indescubribles (sprint/crouch/prone/melee/reload/ADS) — `walker.ts:224-238`. Ayuda por modo + toasts de primer match.
- [ ] UX-M2 · Sin emotes/pings/chat en multi — none. Ping wheel/emote sobre `net`.
- [ ] UX-M6 · Sin ajustes de audio salvo mute global — `game.ts:2774`. Sliders volumen/música/SFX.
- [ ] UX-M7 · Panel settings no accesible limpio; engranaje flota sobre todo — `hud.ts:824-828`. Plegar en pausa/menú.
- [ ] UX-M10 · Respawn fijo 3 s sin protección de spawn — `game.ts:1427,1905-1910`. Protección breve + spawn más seguro.
- [ ] UX-M12 · Sin brújula/markers de objetivo en pantalla — `game.ts:1046-1076`, `hud.ts:143-191`. Franja de brújula con markers.
- [ ] UX-varios · L1 config de balance externalizable · M4 sandbox/vs modos muertos · M8 killfeed setTimeout sin limpiar · M9 innerHTML por frame · L7 input no gateado con modal abierto.

---

## Log de ciclos

_(cada ciclo añade una línea: `Ciclo N | fecha | ítem | commit | gate | notas`)_

- Ciclo 0 | 2026-07-18 | Recon+plan | (sin commit) | baseline tsc+vitest PASA | 4 clusters mapeados, backlog ~60 ítems.
