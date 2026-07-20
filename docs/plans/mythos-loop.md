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

- [x] CBT-C1 · IA "apunta" pero el disparo era `Math.random()<0.55` sin raycast — `src/game.ts:657-668`. **HECHO (ffea274):** `aiShotDamage()` pura fusiona gate de visión + ray-vs-cuerpo sobre la dirección emitida + falloff; el spread ahora causa fallos reales → esquivar moviéndose funciona.
- [x] CBT-C2 · Asimetría host/peer (peer daño incondicional, host 55%) — `src/game.ts:664` vs `666`. **HECHO (ffea274):** mismo `aiShotDamage()` para host y peer → fuego idéntico.
- [x] CBT-H1 · Daño de balas vs bots capado a 30 m mientras el tracer vuela ~180 m — `src/game.ts:1012`. **HECHO (85076b6):** `botHitRange()` pura — no-scoped dañan hasta el alcance del tracer (bulletSpeed×TRACER_LIFE), scoped usan aiRanges al apuntar / 40 m al hip.
- [x] UX-M3 · `beginMatch` no limpiaba estado transitorio (miniDrones, tankChain, recentShots, scanPings, lockId/lockT, firing, ads). **HECHO (c104a37):** `resetTransientCombatState()` llamado en cada beginMatch; sin fantasmas/lock stale/held-fire entre matches.
- [x] **NET-C1** · **(bug corona PvP)** DvH mezclaba eje rol y eje Rojo/Azul → scoring/win/spawn/FF discrepaban. **HECHO (b159300):** `teamForRole()` pura deriva team del rol (drone=0/human=1); `myTeam` así en dvh (beginMatch + assignRoleAndController); picker Rojo/Azul oculto en dvh (solo vs). FF/spawn/radar/tags/scoring/checkWin ya leen un solo eje.
- [x] NET-C2 · Late-join imposible; el que entra a match en curso quedaba atascado en lobby. **HECHO (875df24):** handler `join` reenvía `begin` dirigido (host→joiner) + `beginAddressedToMe` pura; needsync→gridsync ya reconcilia destrucción. Review adversarial pescó y arreglé bug de `hostOf` (joiner sembraba al host en su lobby).
- [ ] NET-C2b · _(nuevo, ciclo 6)_ Late-joiner en dvh siempre cae como human (`myRole ?? "human"`) — `src/game.ts:527-529`. Ofrecer selección de rol/clase al entrar en curso (⇄ UX-H5 deploy screen).
- [ ] NET-H3 · Sin lag-comp/autoridad → "le di y no pasa nada" — `src/game.ts:1326-1336,1312,1340-1345`, `remoteDrones.ts:259-265`. Timestamp de disparos + rewind de peers en la víctima (o autoridad al tirador con sanity-check); ensanchar hitbox más allá de la esfera r=1.0 en el ojo.
- [ ] NET-H4 · Sin balance de equipos ni ready-up; host arranca unilateral; auto-balance muerto — `src/net/lobby.ts:45`, `src/game.ts:483,1233`. Ready-gate + mínimo por equipo + alimentar roster real a `assignRole`. (⇄ UX-H2)
- [x] NET-M1 · Muertes ambientales/suicidio puntuaban para el enemigo. **HECHO (4689c7a):** `deathScores(killer,assists)` pura; flag `scored` gatea addKill en local+peer; self/environment no puntúan.
- [x] NET-M2 · Win DvH deshabilitado en mapas <4 sitios saltaba kill-limit → match sin fin. **HECHO (4689c7a):** checkMatchWin evalúa kill-limit siempre; `killLimitOnlyState` pura (bases 2/2, solo kills ganan, HUD limpio).
- [ ] NET-M3 · Código de sala erróneo crea sala vacía y el joiner se vuelve "host" — `server/relay.mjs:58-60`, `src/game.ts:494,509`. Relay distingue join-existente vs crear; cliente muestra "sala vacía/esperando".
- [ ] NET-H1 · Reconexión inexistente + id nuevo en cada connect (pierde K/D, equipo, spawn) — `src/net/net.ts:30`, `server/relay.mjs:45,58`. Auto-reconnect backoff + token de cliente para restaurar id/team/score.
- [ ] NET-L1 · Relay confía todos los campos, sin rate/size limit ni cap de sala (spoof de scores, flood) — `server/relay.mjs:65-70`. Validar tipos, cap de sala, rate-limit.

### P1 — Gameplay feel (IA drones · armas · PvP)

- [x] CBT-C3 · Armas hitscan sin dispersión → láser pinpoint a 220 m. **HECHO (c242f6b):** bloom acumulado por arma perturba la dirección real (tracer+hitscan+broadcast), crece al disparar y decae; ADS lo aprieta. coneSpread/spreadAngle/addBloom/decayBloom puras+testeadas; sniper pinpoint; determinista. _(Recoil VISUAL de cámara ya existía vía kick/trauma; queda pendiente subir su intensidad si se desea — CBT-C3b.)_
- [ ] CBT-H2 · Sin pathfinding real; "trepar" deja bots varados en techos/muros — `src/net/ai.ts:490-517`. Navgrid/flow-field grueso alrededor de footprints para rutear lateral.
- [x] CBT-H3 · Daño IA era magic `4` plano sin arquetipo/wave. **HECHO (1f207fc):** `dmg` por arquetipo en ARCHETYPES (chaser3/gunner4/diver5/tank7/support2/kamikaze0) + `dmgScale(wave)`/`archDamage` puras; viaja en el fire record → aiShotDamage aplica falloff+piso1; host/peer consistentes. _(⇄ CBT-M2: ahora que el daño varía, hace falta que los arquetipos se VEAN distintos.)_
- [x] CBT-H4 · Recargas instantáneas sin tiempo/lockout → sin tensión. **HECHO (dcd1aa0):** `reloadDuration(spec)` pura bloquea el disparo por arma; auto-recarga al vaciar la tolva inicia una recarga cronometrada sin disparar; R manual cronometrada, no-op durante recarga; reset en switch/clase/inicio/resupply. _(Pendiente CBT-H4b: barra/indicador de recarga en HUD + anim de recarga en viewmodel; y que resupply en base no cancele el lock silenciosamente — cosmético.)_
- [x] CBT-H5 · Sin niveles de dificultad; solo rampa "BRUTAL". **HECHO (068fbef):** `AiSwarm.difficulty` (mult, default 1) escala wave/velocidad/cadencia/spread/daño; `difficultyMul` pura (easy0.7/normal1/hard1.35); `?diff=`. Invariante: default=1 byte-idéntico → GOLD_AI intacto. _(CBT-H5b: hard×1.35 excede el cap de 60 —hasta 81 bots— sin overflow pero rompe el plateau; picker de lobby → fase UX.)_
- [B] **CBT-H2** · Sin pathfinding real; bot bloqueado solo sube y se vara en techos/muros — `src/net/ai.ts:490-524,openingSeek`. **DIFERIDO (ciclo 12):** demasiado intrincado para un ciclo limpio (march+opening-seek+wantY sutiles; un sidestep ingenuo arriesga oscilación/atasco nuevo; movimiento mueve el golden con barra alta). Necesita esfuerzo dedicado con navgrid/flow-field grueso alrededor de footprints + test de "ya no se vara" + verificación empírica.
- [x] CBT-H6 · Peers no disparaban evasión IA (no se enviaba su aim). **HECHO (d4cbce4):** cada cliente difunde su aim (mismo camera.getWorldDirection que el host, ax/az en state) → sin adivinar signo del yaw; propaga upsert→Remote→humanTargets→targets; backward-safe (peer sin aim = undefined, no 0). Sim/golden intactos.
- [ ] CBT-H7 · Movimiento orbit-strafe predecible + evasión débil — `src/net/ai.ts:448-450,479`. Burst-strafes/jukes de altitud, break-off, cover-seeking.
- [x] CBT-M1 · Sin hitzones/headshots → TTK plano. **HECHO (dfb9b14):** `hitZone()` pura añade sub-esfera de cabeza aditiva (sin regresión de body-gate) + `HEADSHOT_MULT=1.8`; resuelto donde aterriza el daño (PvP víctima / bots host), sin doble-mult. _(CBT-M1b HECHO 5c169d7: radio 0.4→0.28 PvP / 0.5→0.4 bot; marker 'head' dorado dedicado; body-radii intactos. Follow-up restante: cue de headshot en pellets de escopeta.)_
- [ ] CBT-M2 · Arquetipos de bot invisibles; bots dañados sin vida — `src/game.ts:627`. Difundir hp/maxHp + tag de arquetipo; tinte/escala + barra al dañarse.
- [ ] CBT-M4 · Modelo dual de bala (hitscan instantáneo + tracer físico) → travel-time falso — `projectile.ts:147-169` + `game.ts:2350`. Elegir un modelo.
- [ ] CBT-M3 · Kamikaze IA power `1.4` vs jugador `1400` (gap 1000×) — `src/game.ts:682`. Verificar carve power.
- [x] CBT-M5 · Bots disparaban sin telegrafía al primer peek. **HECHO (5279d7e):** campo `sacq` (vista continua) + `acquireDelay(wave)` pura; el gate de disparo exige ventana de adquisición (0.4s→0.12s por wave); host-only, determinista. GOLD_AI re-baselineado (review probó empíricamente posiciones byte-idénticas). _(Nota: sacq congela —no resetea— durante EMP stun; defendible.)_
- [~] CBT-M6 · **VERIFICADO NO-BUG (ciclo 18):** `explodeAt` (game.ts:2182) YA aplica falloff `(1-dist/dr)*55` al jugador; la granada IA daña vía explodeAt (con falloff); el flat-30 del kamikaze es bonus de CONTACTO (`distXZ<=2.4`, siempre cerca) → no es "granada a 3 m pega 30". Cerrado sin cambio.
- [ ] CBT-M7 · Spawn en anillo determinista — `src/net/ai.ts:339`. Jitter con rng sembrado.
- [ ] CBT-tune1 · _(nuevo, ciclo 3)_ Balance de alcance vs bots: smg (identidad close-range) y laser ahora plinkean a 180/600 m con `botDmg` plano — considerar falloff de botDmg o cap por arma. `src/net/weapons.ts:botHitRange`.
- [ ] CBT-tune2 · _(nuevo, ciclo 3)_ `TRACER_LIFE=1.5` duplica el literal en `projectile.ts:168`; unificar (projectile importa la const) para que tuning del tracer no diverja del alcance de daño.

### P2 — Rendimiento (stutters)

- [x] RND-C1 · Stall de compilación de shader al primer render de cada modelo async (picos ~157 ms). **HECHO (af0e897):** `Renderer.warmScene(camera)` = `compileAsync(escena REAL, camera)` en background tras montar avatar/arma/HQ (callback `warm`); programa correcto (escena real, sin prewarm-a-mano que mismatchee), best-effort `.catch`, mejora-estricta-o-noop. _(WIN del spike = verifica usuario en GPU real; gate cubrió correctness/no-crash.)_ RULE: perf-render con falso-pass-invisible → usar compileAsync sobre escena REAL (no mesh a mano) para que sea noop-o-mejora, nunca silent-worse.
- [ ] RND-C2 · Swarm ~30 draws por bot, sin instancing cross-bot — `remoteDrones.ts:331-364`, `game.ts:627`. Fusionar a 1 mesh o InstancedMesh por parte; conectar `selectGltfBots` LOD.
- [ ] RND-H1 · Auto-downgrade de preset = recompile completo (~1 s freeze) — `game.ts:1561-1595`. Togglear uniforms/defines en vez de swap de materiales; o compileAsync.
- [ ] RND-H2 · Dynamic-res `setPixelRatio` realoca framebuffer mid-frame — `renderer.ts:93-99`, `game.ts:2939-2951`. Histéresis más ancha + escalas discretas + realoc en frame boundary.
- [ ] RND-H3 · Segundo render de escena completa al mirar por mira — `renderer.ts:195-224`, `game.ts:3030`. Mira a menor res, far plane, reusar depth, saltar partículas.
- [B] RND-L3 · (Re)build de ~1.5M vóxeles síncrono (~700 ms freeze) al cargar/reiniciar — `game.ts:1949,3187`. **DIFERIDO (ciclo 14):** cambia el flujo de arranque + streaming + interplay colliders/heightField, y tiene FALLO SILENCIOSO (mesh roto=mundo en blanco que el smoke no detecta — chequea grid vía debugVoxelCount, no que la geometría se dibuje). No es noop-o-mejora. Necesita decomposición + añadir un check de "mesh construido>0" al smoke antes de ser loop-safe.
- [ ] RND-GLTF · GLTFLoader sin DRACO/meshopt/KTX2 → parse sin comprimir en main thread — `modelLoader.ts:16`, `instancedModel.ts:12`. Adjuntar decoders worker-backed.
- [ ] RND-M-part · Capa de puntos dibuja el buffer completo (262k) mientras haya partículas vivas — `gpuParticles.ts:295-297,349`. Compactar a draw range denso o bajar texSize en GPU débil.

### P3 — Visual / modelos / animaciones

- [B] RND-H4 · Modelos por-clase dead-code; todo peer idéntico ("malos modelos 3d") — `avatarModels.ts` vs `remoteDrones.ts:161-163`. **DIFERIDO (ciclo 21):** `unitModel(role,cls)` puro y los .glb existen, PERO los sol_*.glb podrían NO estar riggeados (sin Idle/Walk/Run → mixer.update(0)=T-pose) = FALLO SILENCIOSO invisible al gate headless. Necesita verificar rigging de cada .glb (cargar/visual/Chrome). Los drones/KIND_MODEL (no-skinned) son slice más seguro.
- [ ] RND-V1 · Sin IBL/env map → PBR plano, metales casi negros (mayor driver de "visual pobre") — `renderer.ts:44-48`. Bake de PMREM pequeño del cielo → `scene.environment`.
- [ ] RND-A1 · Soldado riggeado pierde aim-pitch y pose de stance (nunca mira arriba/abajo ni se agacha visiblemente) — `remoteDrones.ts:168-183,273-281`. Aplicar pitch a hueso de cuello/espina; bajar mount para crouch/prone.
- [x] RND-A2 · Drones sin orientación (todos miran +Z deslizando de lado). **HECHO (2e81e35):** en remoteDrones.update, un drone con quat identidad (bot IA) se orienta hacia su velocidad (`facingYawFromVelocity` pura + slerp, speed-gate anti-giro-en-hover); PvP drones sin cambio; render-only, sin broadcast. _(RND-A2b: banking/roll en giros — follow-up.)_ RULE: bots IA se difunden con quat identidad → distinguirlos por `|w|>0.9999` para no pisar la orientación real de drones-jugador.
- [ ] RND-A3 · Solo 3 estados de anim, melee invisible en modelo riggeado — `remoteDrones.ts:287-299`. Clips aim/fire/melee/death o capas aditivas de torso.
- [ ] RND-A4 · Walk procedural = seno crudo sin foot-planting — `humanPose.ts:25-29`. Knee bend + foot-lock/plant + easing.
- [ ] RND-V2 · Sombras duras low-res short-range (PCF 1024, 35 m) — `renderer.ts:30,56,62-66`. PCFSoftShadowMap + mapa mayor/cascada.
- [ ] RND-V3 · Post-proceso solo bloom y solo alto; sin AO/FXAA en medio/bajo — `renderer.ts:103-135`. SSAO barato + FXAA fallback.
- [ ] RND-V4 · Viewmodels Kenney chocan con la ciudad voxel; materiales plástico sin mapas — `viewmodel.ts:16-34,54-62`. Set PBR texturizado consistente.

### P4 — Lobby / pantallas / UX / opciones

- [ ] UX-C1 · Sin pausa / menú in-game (Esc solo suelta el ratón) — `input.ts:37-39`, `game.ts:2770-2810`. Estado de pausa que congela sim + overlay Resume/Settings/Leave. **Mayor gap "no es juego completo".**
- [ ] UX-C2 · "Salir"/"Menú"/restart hacen `location.reload()` (pantalla negra multi-segundo) — `game.ts:385,439,493-505`. Transición real de vuelta a menú sin reload.
- [x] UX-C3 · Ayuda equivocada en combate (mostraba controles de sandbox). **HECHO (5ee6056):** `HELP_COMBAT` por modo con bindings VERIFICADOS contra onKey/walker/input (WASD/C-agachar/Z-prone/Shift/Clic-der-ADS/1-6 armas/V-melee/R-recargar/Tab-O-K-M-H); `toggleHelp(combat)` recomputa; test bloquea los 2 textos separados. RULE: ayuda/UI de controles = construir desde los bindings REALES leídos en la fuente (un keybind adivinado = fallo silencioso de info-mala que el gate no ve).
- [x] UX-C4 (sens) · Sin sensibilidad de ratón configurable (SENS hardcodeado). **HECHO (5f58ef8):** `VisualSettings.sensitivity` (mult, default 1, clamp [0.2,4], persistido) + holder compartido `lookSens` leído por player/walker (incl. ADS); slider en ajustes; invariante default=1 byte-idéntico; camera.ts dead-code. _(UX-C4b: rebinding de teclas + invert-Y/FOV — follow-up.)_
- [ ] UX-H1 · Menú de inicio pobre (2 botones + código) — `hud.ts:994-1004,452-463`. Settings, How-to-Play, Solo/Practice.
- [ ] UX-H2 · Lobby sin ready-up, sin mínimo de jugadores, sin balance de equipos — `game.ts:483-487`. Ready por jugador + checks + conteo Rojo/Azul.
- [ ] UX-H3 · Sin scoreboard completo (TAB = zoom minimapa) — `game.ts:2771`, `hud.ts:357-368`. Overlay scoreboard ambos equipos K/D/A.
- [ ] UX-H4 · Pantalla game-over mínima/genérica — `hud.ts:278-311`. Results dedicado con stats por jugador, MVP, precisión.
- [ ] UX-H5 · Sin loadout/deploy; clase fija todo el match — `game.ts:526-527,1369-1375`. Cambio de clase al morir/respawn.
- [ ] UX-H6 · Sin estado de conexión de red en UI — `game.ts:430`. Connecting/Connected/Lost.
- [x] UX-H7 · Artefactos de dev en vista del jugador (link "Demo WebGPU" + panel de stats). **HECHO (c62728c):** ambos `display:none` por defecto (sin flash), revelados solo con `?perf` vía `devOverlaysEnabled(search)` pura+testeada (incl. que `?ptex=256` del smoke NO los activa); sin conflicto de param.
- [ ] UX-H8 · Interacción solo implícita; sin tecla/prompt de "usar" — `game.ts:2570-2600`, `walker.ts:203-214`. Tecla interact + framework de prompt.
- [ ] UX-H9 · `game.ts` = god object 3195 líneas — `src/game.ts`. Extraer NetRouter, AiHost, WeaponsController, ScreenFlow, PerfProfiler. (Refactor grande — escalonar.)
- [ ] UX-M1 · Acciones del jugador indescubribles (sprint/crouch/prone/melee/reload/ADS) — `walker.ts:224-238`. Ayuda por modo + toasts de primer match.
- [ ] UX-M2 · Sin emotes/pings/chat en multi — none. Ping wheel/emote sobre `net`.
- [x] UX-M6 · Sin ajustes de audio salvo mute global. **HECHO (3e899ea):** slider de volumen maestro (VisualSettings.volume 0..1, default 1, persistido) → `master.gain = 0.62 * volumeCurve(v)` (v² pura); toggleMute restaura el volumen SETeado; invariante default=1 byte-idéntico. _(UX-M6b: sliders separados música/SFX — follow-up.)_
- [x] UX-M7 · Engranaje de ajustes flotaba sobre todas las pantallas. **HECHO (8c7780a):** `refreshGear()` (llamado en cada show/hide de menu/lobby/game-over) oculta el engranaje mientras hay un modal y lo restaura en gameplay; `anyModalOpen()` pura+testeada.
- [ ] UX-M10 · Respawn fijo 3 s sin protección de spawn — `game.ts:1427,1905-1910`. Protección breve + spawn más seguro.
- [ ] UX-M12 · Sin brújula/markers de objetivo en pantalla — `game.ts:1046-1076`, `hud.ts:143-191`. Franja de brújula con markers.
- [ ] UX-varios · L1 config de balance externalizable · M4 sandbox/vs modos muertos · M8 killfeed setTimeout sin limpiar · M9 innerHTML por frame · L7 input no gateado con modal abierto.

---

## Log de ciclos

_(cada ciclo añade una línea: `Ciclo N | fecha | ítem | commit | gate | notas`)_

- Ciclo 0 | 2026-07-18 | Recon+plan | (sin commit) | baseline tsc+vitest PASA | 4 clusters mapeados, backlog ~65 ítems.
- Ciclo 1 | 2026-07-18 | CBT-C1+C2 (IA raycast) | ffea274 | tsc0·vitest454·review-adversarial-OK·smoke-OK | ejecutor Fable5 + refactor pura aiShotDamage p/cerrar hueco de cobertura del review. Dev server vivo en :5173 p/checks.
- Ciclo 2 | 2026-07-19 | NET-C1 (dvh team=rol) | b159300 | tsc0·vitest457·review-adversarial-OK·smoke-OK | bug corona PvP; helper puro teamForRole; picker Rojo/Azul oculto en dvh. Fable5.
- Ciclo 3 | 2026-07-19 | CBT-H1 (rango balas vs bots) | 85076b6 | tsc0·vitest459·auto-review-cross-model-OK·smoke-OK | botHitRange pura; review por Opus directo (cambio pequeño); +2 items de tuning al backlog. Fable5.
- Ciclo 4 | 2026-07-19 | NET-M1+M2 (scoring/win dvh) | 4689c7a | tsc0·vitest463·review-adversarial(1 fix UI)·smoke-OK | deathScores + killLimitOnlyState puras; review adversarial pescó base-💥 falsa en HUD (obj 1→2). Fable5.
- Ciclo 5 | 2026-07-19 | UX-M3 (reset transitorio) | c104a37 | tsc0·vitest463·auto-review-cross-model·smoke-OK | resetTransientCombatState en beginMatch; sin test unitario (limpieza imperativa Game, fuera de alcance suite). Fable5.
- Ciclo 6 | 2026-07-19 | NET-C2 (late-join) | 875df24 | tsc0·vitest466·review-adversarial(1 fix hostOf)·smoke-OK | begin dirigido host→joiner + beginAddressedToMe pura; review pescó restart-hijack por hostOf (joiner siembra al host). +1 item NET-C2b. **P0 correctness = COMPLETO.** Fable5.
- Ciclo 7 | 2026-07-19 | CBT-C3 (dispersión/bloom armas) | c242f6b | tsc0·vitest474·review-adversarial-OK·smoke-OK | **inicia P1 gameplay feel.** coneSpread+bloom puras; review verificó math del cono (unit+cono+sin NaN) y determinismo. +CBT-C3b (recoil visual intensidad). Fable5.
- Ciclo 8 | 2026-07-19 | CBT-H4 (recargas con tiempo) | dcd1aa0 | tsc0·vitest479·review-adversarial(1 fix guard)·smoke-OK | reloadDuration pura; review pescó guard muerto en reloadOrScan (movido al tope). +CBT-H4b (HUD reload bar). Fable5.
- Ciclo 9 | 2026-07-19 | CBT-H3 (daño IA por arquetipo) | 1f207fc | tsc0·vitest482·review-adversarial-OK·smoke-OK | dmg en ARCHETYPES + dmgScale/archDamage puras; review verificó determinismo+host/peer+kamikaze-inalcanzable. Fable5.
- Ciclo 10 | 2026-07-20 | CBT-M5 (delay de adquisición IA) | 5279d7e | tsc0·vitest484·review-adversarial(prueba empírica golden)·smoke-OK | sacq+acquireDelay puras; GOLD_AI re-baselineado — review PROBÓ empíricamente posiciones byte-idénticas (solo cambia disparo). RULE: golden re-baseline en cambio deliberado exige separar hash movimiento/disparo. Fable5.
- Ciclo 11 | 2026-07-20 | CBT-M1 (headshots) | dfb9b14 | tsc0·vitest489·review-adversarial-OK·smoke-OK | hitZone pura aditiva (sin regresión body-gate); review verificó paridad+sin-doble-mult+object-truthiness-trap evitada. +CBT-M1b tuning. Fable5.
- Ciclo 12 | 2026-07-20 | CBT-H5 (dificultad) | 068fbef | tsc0·vitest493·GOLD_AI-intacto·review-adversarial-OK·smoke-OK | difficulty mult default 1; RULE: mult con default=1 (x*1.0===x) preserva golden byte-idéntico → review confirma identidad sin re-baseline. Pivot: CBT-H2 diferido (muy intrincado). +CBT-H5b cap. Fable5. **Fin P1 HIGH → transición a P2 perf.**
- Ciclo 13 | 2026-07-20 | RND-C1 (pre-warm shaders) | af0e897 | tsc0·vitest493·smoke-OK·auto-review | **inicia P2 perf.** warmScene=compileAsync(escena real) tras montar modelos; aditivo +31/-0, mejora-estricta-o-noop. RULE: perf-render no medible headless → elegir cambios noop-o-mejora (compileAsync escena real, no mesh a mano) para que el falso-pass no pueda empeorar; WIN lo verifica el usuario. Fable5.
- Ciclo 14 | 2026-07-20 | CBT-H6 (aim de peers p/evasión IA) | d4cbce4 | tsc0·vitest497·GOLD_AI-intacto·review-adversarial-OK·smoke-OK | pivot desde RND-L3 (fallo silencioso: mesh roto=mundo blanco que el smoke no ve). RULE: convención de signo (yaw→forward) es headless-inverificable → difundir la MISMA representación que el host (correcto-por-construcción); gate undefined-vs-0 crítico (no default a 0). Fable5. **RULE meta: en loop headless, si un ítem tiene fallo-silencioso que el gate no detecta, diferirlo o hacerlo noop-o-mejora; perf puros → verificación GPU real.**
- Ciclo 15 | 2026-07-20 | RND-A2 (facing de drones) | 2e81e35 | tsc0·vitest502·golden+ai-intactos·smoke-OK·auto-review | render-only aditivo, facingYawFromVelocity pura + speed-gate; distinguir bot IA (quat identidad) de drone-jugador por |w|>0.9999. Visual lo verifica el usuario. Fable5.
- Ciclo 16 | 2026-07-20 | UX-C3 (ayuda por modo) | 5ee6056 | tsc0·vitest505·smoke-OK·auto-review | HELP_COMBAT verificado contra la fuente (onKey/walker/input), cada keybind cruzado; test bloquea combate vs sandbox. RULE: UI de controles se construye desde bindings REALES leídos, no adivinados. Fable5.
- Ciclo 17 | 2026-07-20 | UX-H7 (ocultar dev-artifacts) | c62728c | tsc0·vitest510·smoke-OK·auto-review | devOverlaysEnabled pura; display:none por defecto (sin flash) + reveal con ?perf; test incluye que el param del smoke no los active. Fable5.
- Ciclo 18 | 2026-07-20 | UX-M7 (engranaje sobre modales) + verif CBT-M6 | 8c7780a | tsc0·vitest515·smoke-OK·auto-review·UI-only | refreshGear + anyModalOpen pura. RULE: verificar-primero un supuesto bug del recon antes de "arreglar" — CBT-M6 resultó no-bug (explodeAt ya tiene falloff); el loop cierra no-bugs sin cambio. Fable5.
- Ciclo 19 | 2026-07-20 | UX-C4 (sensibilidad de ratón) | 5f58ef8 | tsc0·vitest518·golden+ai-intactos·review-adversarial-OK·smoke-OK | lookSens holder compartido + sensitivity persistido; invariante default=1 byte-idéntico. RULE: opción de input/wiring con riesgo de "slider inerte" (headless-inverificable) → un solo holder compartido leído por TODOS los controladores + default-neutro que preserva el comportamiento; review cruza los 3 controladores. Fable5. **Lección etapa 7 consolidada en lessons.md (check-lessons OK).**
- Ciclo 20 | 2026-07-20 | UX-M6 (slider de volumen) | 3e899ea | tsc0·vitest525·golden+ai-intactos·review-adversarial-OK·smoke-OK | master gain único = punto de control; MASTER_BASE + volumeCurve v² puras; toggleMute restaura volumen SETeado; invariante default=1. Fable5.
- Ciclo 21 | 2026-07-20 | CBT-M1b (tuning headshot) | 5c169d7 | tsc0·vitest527·golden+ai-intactos·smoke-OK·auto-review | radio cabeza 0.4→0.28/0.5→0.4 + marker 'head' dedicado. RULE: rutar modelos por-clase riesga T-pose silencioso si los .glb no tienen clips → verificar rigging o diferir (RND-H4 [B]). Fable5.
