import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { DEBRIS_HIT_DRONE_R, DEBRIS_HIT_TANK_R, DEBRIS_IMPACT_KE, FIXED_DT, MAX_DEBRIS, RENDER_DIST, VOXEL, maxPhysicsSteps } from "./config";
import { Player } from "./engine/player";
import { Walker } from "./engine/walker";
import { Input } from "./engine/input";
import { PerfGovernor } from "./engine/perfGovernor";
import { qualityConfig, QUALITY_ORDER, lowerQuality, LOW_FPS, type Quality } from "./engine/quality";
import { loadSettings, saveSettings, autoSettings, clampViewDist, clampResScale, type VisualSettings } from "./engine/settings";
import { nextResScaleGpu, nextResScaleFps, RES_MIN } from "./engine/dynamicRes";
import { shouldRefreshShadows, SHADOW_MOVE_SQ } from "./engine/shadowPolicy";
import { nextPerfLever } from "./engine/perfLever";
import { Rng, eventSeed, EVT, q2, q3 } from "./engine/rng";
import { CookService } from "./world/cookService";
import { collapseTick, CELL_OVERHANG, CELL_MIN_MASS } from "./destruction/collapse";
import { GpuTimer, makeGpuTimer } from "./engine/gpuTimer";
import { humanFallDamage, droneImpactDamage } from "./engine/falldamage";
import { Physics, GROUP_GROUND } from "./engine/physics";
import { Renderer, SCOPE_CIRCLE_R } from "./engine/renderer";
import { DebrisSystem } from "./destruction/debris";
import { DEBRIS_CT, type CarveTargets } from "./destruction/carve";
import { resolveDebrisImpacts } from "./destruction/impact";
import { explode } from "./destruction/explosion";
import { Projectiles } from "./destruction/projectile";
import { Particles, type ParticleKind, type ParticleSink } from "./fx/particles";
import { GpuParticles } from "./fx/gpuParticles";
import { ImpactMarks } from "./fx/impactMarks";
import { RubbleField } from "./fx/rubble";
import { HeightField } from "./fx/heightField";
import { placeVoxel, eraseVoxel, type EditRegion } from "./build/editor";
import { BIG, ammoBoxSites, medkitSites, buildBuilding, buildCar, buildDefaultScene, buildHouse, buildObjectives, buildTower, buildWall, CITY_VOX, FOREST_RING, groundClass, objectiveHp, OBJECTIVE_SITES, PLAY_BOUNDS, placedBuildings, setWorldSeed, setMapSize, MAP_SIZES, type MapSize } from "./build/prefabs";
import { InteriorLights } from "./engine/interiorLights";
import { Hud, type Mode, type Tool, type RadarBlip, type RadarShot } from "./ui/hud";
import { bearing, inScanCone } from "./ui/radar";
import { rotorLevel, rotorCutoff, rotorPitch, rotorPan, frontBrightness } from "./fx/rotorAudio";
import { CameraFx } from "./fx/cameraFx";
import { addTrauma, decayTrauma, shakeOffset, HUMAN_FOV } from "./engine/cameraFeel";
import { GameAudio } from "./fx/audio";
import { Scenery } from "./fx/scenery";
import { AmmoCrates } from "./fx/ammoCrates";
import { BaseModels } from "./fx/baseModels";
import { Viewmodel } from "./engine/viewmodel";
import { Net, type NetMsg } from "./net/net";
import { RemoteDrones, MAX_HP } from "./net/remoteDrones";
import { assignRole, roleWeapon, classMaxHp, classLoadout, classMove, classStats, defaultClass, teamForRole, TEAM_LABEL, type Role, type Team, type UnitClass } from "./net/roles";
import { makeRoomCode, emptyLobby, applyJoin, applyLeave, applyPick, hostOf, type LobbyState } from "./net/lobby";
import { AiSwarm, pickTarget, homingStep, type AiTarget, type AiDrop, type AiBoom, type AiNoise, type AiBreak } from "./net/ai";
import { respawnDelay, wallBlocks, smokeOccludes, playerSpawn, cardinalPoint, farthestCardinal, WAVE_DIRS, bandageStep, canBeginMatch, beginAddressedToMe, BANDAGE_HEAL, BANDAGE_MAX, BANDAGE_DUR, type Cardinal, type SmokeCloud } from "./net/coop";
import { WEAPONS, tryFire, reloadMag, reloadDuration, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere, meleeHit, bulletFalloff, aiShotDamage, botHitRange, spreadAngle, addBloom, decayBloom, coneSpread, type Weapon, type Ammo } from "./net/weapons";
import { checkWin, reconcileKills, baseAlert, deathScores, killLimitOnlyState, type MatchState } from "./net/objectives";
import { MATERIAL_ORDER, MATERIALS, type MaterialId } from "./world/materials";
import { packKey, unpackKey, KEY_SPAN, VoxelGrid, type RayHit } from "./world/voxelGrid";
import { chunkCoord, VoxelCollider } from "./world/voxelCollider";
import { MESH_CHUNK, MESH_CHUNK_RATIO } from "./world/cook";
import { VoxelMesher } from "./world/voxelMesh";
import { connectedComponents, type Voxel } from "./world/structuralIntegrity";

// Inline packed-key decode (same arithmetic as unpackKey, minus the per-call tuple) for the per-frame streams.
const KEY_HALF = KEY_SPAN >> 1;

// Structural-collapse constants (CELL_OVERHANG, CELL_MIN_MASS, PANCAKE_FRAC, COLLAPSE_BUDGET) + the pure
// collapseTick now live in ./destruction/collapse so the tick runs headless in the divergence harness.

/** Deterministic 32-bit hash of the room code → world seed (so all clients build the same world). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

interface Flash {
  light: THREE.PointLight;
  life: number;
  max: number;
  intensity: number;
}

interface Prop {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

export class Game {
  private readonly physics = new Physics();
  private readonly renderer: Renderer;
  private player: Player | Walker; // drone (Player) in most modes; swapped to Walker for a human
  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly camFx = new CameraFx(); // FPV/body-cam overlay skinned by role
  private readonly audio = new GameAudio(); // procedural SFX (its live context also keeps the tab awake)
  private interiorLights?: InteriorLights;  // dim/flickering lights inside some buildings
  private scenery?: Scenery;                // trees + drifting clouds (visual scene dressing)
  private ammoCrates!: AmmoCrates;          // soldier ammo-supply pickups on the streets (set in ctor)
  private medkits!: AmmoCrates;             // soldier bandage-restock pickups (red crates; set in ctor)
  private viewmodel!: Viewmodel;            // first-person held-weapon model (soldiers; set in ctor)
  private baseModels!: BaseModels;          // decorative team HQ over each dvh base (set in ctor)
  private vmPrevX = 0; private vmPrevZ = 0; private vmHasPrev = false; // pre-shake cam XZ → clean walk-bob speed
  private flashlight?: THREE.SpotLight;     // head-mounted torch for the local player (F to toggle)
  private flashOn = false;

  private readonly grid = new VoxelGrid();
  private readonly mesher: VoxelMesher;
  private readonly collider: VoxelCollider;
  private readonly debris: DebrisSystem;
  private readonly rubble: RubbleField;
  private readonly particles: Particles;
  private readonly gpu: GpuParticles | null;
  private readonly sink: ParticleSink;
  private readonly impactMarks: ImpactMarks;
  private readonly projectiles: Projectiles;
  private readonly targets: CarveTargets;

  private readonly governor = new PerfGovernor();
  private lowFpsSec = 0;          // seconds of sustained low fps → triggers an adaptive quality drop
  private resScale = 1;           // current dynamic-resolution scale (fill-rate lever)
  private settings!: VisualSettings; // player's visual settings (quality/resolution/view distance); set in ctor
  private renderDist = RENDER_DIST;  // live view-bubble radius (metres); from settings, adjustable in the menu
  private resTimer = 0;           // debounce so the drawing-buffer realloc doesn't thrash
  private lastResChange = 0;      // time of the last render-scale realloc — rate-limits the drawing-buffer stall
  private gpuTimer!: GpuTimer;    // real GPU-ms of the render (drives dynamic resolution); set in ctor
  private shadowSince = 99;       // frames since the last shadow-map refresh (starts high → refresh frame 1)
  private readonly lastShadowPos = new THREE.Vector3(); // camera pos at the last refresh (movement gate)
  private voxelDetailOn = true;   // live mortar-detail state (perf floor lever, separate from the preset)
  private worldSeed = 0;          // room-code seed → per-event RNG seeds (deterministic destruction)
  private cookService!: CookService; // off-thread greedy-box cooking for collider rebuilds; set in ctor
  private trauma = 0;             // screen-shake energy (0..1) from blasts/damage/firing; decays each frame
  private readonly heightField = new HeightField();
  private static readonly MAX_FLASHES = 5;
  private readonly flashes: Flash[] = [];
  private readonly props: Prop[] = [];
  // x/y/z = the cluster's WORLD centre, precomputed once per rebuildGasTanks (constant per world) so the
  // per-frame applyDebrisImpacts never re-derives it; the array itself satisfies resolveDebrisImpacts' input.
  private gasTanks: { vox: Voxel[]; cx: number; cy: number; cz: number; x: number; y: number; z: number; live: boolean }[] = [];
  private readonly _droneScratch = { x: 0, y: 0, z: 0 }; // reused per frame by applyDebrisImpacts
  private readonly tankChain: { cx: number; cy: number; cz: number; delay: number }[] = [];

  private tool: Tool = "shoot";
  private matIndex = 1; // concrete
  private brush = 0;
  // weapon reload: a tool can't fire again until game time passes its readyAt
  private grenadeReadyAt = 0;
  private missileReadyAt = 0;
  // --- team combat (vs/dvh): per-team weapon loadout, ammo, drone battery ---
  private weapon: Weapon = "mg";
  private readonly ammo: Record<Weapon, Ammo> = Object.fromEntries(
    (Object.keys(WEAPONS) as Weapon[]).map((w) => [w, fullAmmo(WEAPONS[w])]),
  ) as Record<Weapon, Ammo>;
  private readonly smokeClouds: SmokeCloud[] = []; // active smoke grenades: block LOS (both ways) until they expire
  private smokeFxAt = 0;                           // throttle for the sustained smoke particle emission
  // soldier's interceptor swarm: local homing mini-drones that ram the nearest enemy drone (kill is host-auth)
  private readonly miniDrones: { mesh: THREE.Object3D; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; boom?: boolean; target?: number }[] = [];
  // reused per frame by miniDroneFrame (scratch snapshot + its object pool) — no per-frame allocation
  private readonly _miniBots: { id: number; x: number; y: number; z: number }[] = [];
  private readonly _miniBotPool: { id: number; x: number; y: number; z: number }[] = [];
  private readonly turrets: { mesh: THREE.Object3D; head: THREE.Object3D; x: number; y: number; z: number; cd: number; until: number; yaw: number; pitch: number }[] = []; // deployed sentries (head tracks smoothly / scans when idle)
  private readonly turretMat = new THREE.MeshStandardMaterial({ color: 0x3a4a3a, roughness: 0.7, metalness: 0.4, emissive: 0x0a2a0a, emissiveIntensity: 0.5 });
  private readonly turretAccentMat = new THREE.MeshStandardMaterial({ color: 0xff5533, roughness: 0.4, metalness: 0.3, emissive: 0xff3311, emissiveIntensity: 1.4 }); // the sensor "eye" (shared → not disposed)
  private readonly miniGeo = new THREE.SphereGeometry(0.16, 10, 8);
  private readonly miniMat = new THREE.MeshBasicMaterial({ color: 0x7cffd0 }); // glowing interceptor orb
  // lock-on missile parts (shared across shots; assembled nose-forward along +Z in makeMissile so
  // mesh.lookAt(pos + vel) each frame leads with the nose)
  private readonly msBodyGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.32, 10).rotateX(Math.PI / 2);
  private readonly msNoseGeo = new THREE.ConeGeometry(0.055, 0.14, 10).rotateX(Math.PI / 2);
  private readonly msFinGeo = new THREE.BoxGeometry(0.012, 0.1, 0.09);
  private readonly msGlowGeo = new THREE.SphereGeometry(0.05, 8, 6);
  private readonly msBodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.45, metalness: 0.7 });
  private readonly msNoseMat = new THREE.MeshStandardMaterial({ color: 0xcc2a1a, roughness: 0.35, metalness: 0.55, emissive: 0x6a1008, emissiveIntensity: 0.7 }); // hot warhead tip
  private readonly msFinMat = new THREE.MeshStandardMaterial({ color: 0x2e3236, roughness: 0.7, metalness: 0.4 });
  private readonly msGlowMat = new THREE.MeshBasicMaterial({ color: 0x7cffd0 }); // exhaust glow
  private weaponReadyAt = 0;      // shared per-shot cooldown gate
  private reloadingUntil = 0;     // firing is locked out until this time (a reload is in progress)
  private bloom = 0;              // accumulated auto-fire spread (radians); grows per shot, decays between shots
  private lastBloomT = 0;         // when bloom was last decayed (lazy decay at the next shot)
  private firing = false;         // LMB held → auto-fire (machine gun) each frame at the weapon's rate
  private ads = false;            // RMB held → aim down sights (only engages for a scoped weapon; see applyAds)
  private bulletReadyAt = 0;      // free-mode auto-fire cadence gate
  private battery = BATTERY_MAX;  // drone battery (drains with movement; 0 → fall & die)
  private combatHudT = 0;         // throttle for the combat HUD panels
  private statsT = 0;             // throttle for the fps/debris/wind stats DOM write (~6Hz, not every frame)
  private lowBatBeepAt = 0;       // next time a low-battery beep may play
  private meleeReadyAt = 0;       // human melee cooldown gate
  // personal scoreboard (K/D/A). Kills/assists are attributed by the victim's `died` broadcast.
  private myKills = 0;
  private myAssists = 0;
  private myDeaths = 0;
  private readonly damagers = new Map<number, number>(); // peer id → game time they last damaged me
  private rebuildAllColliders = false;
  private readonly dirtyChunks = new Set<number>();      // chunks whose MESH needs rebuilding (prompt)
  private readonly dirtyCol = new Map<number, number>(); // chunk → last-touched time; collider rebuilt once quiet
  private structureDirty = false; // a blast changed the grid → re-solve the cell support graph
  private collapseSfxAt = 0;      // rate-limit the structure-collapse rumble (cascades fire many waves/frame)
  private pendingFall: number[] = []; // fallen-cell wave being drained over frames (avoids re-solving each frame)
  private syncedFromPeer = false; // a late joiner applies exactly one grid-reconciliation snapshot per world
  // collision LOD: only the building chunks within this many CHUNKs of the player carry physics
  // colliders. Keeps the active collider count (and the broadphase cost) independent of building
  // size — the static world doesn't all live in the physics engine at once.
  // Radius 1 (was 2): perf.log showed that flying the DENSE tripled city put up to 78 chunks / 3474
  // static colliders in the broadphase, and each streamed chunk forced Rapier to re-optimise it →
  // phys worstMs 20-27 ms *with zero debris* (the "tirón al moverse"). A CHUNK is 32·VOXEL = 8 m, so
  // radius 1 still always keeps the player's own chunk + one ring built (≥8 m of collider in every
  // direction — a drone would need >500 m/s to out-run it), while cutting the collider cube 125→27
  // chunks (~4.6×): fewer colliders in the broadphase AND far cheaper re-opts as chunks stream.
  private static readonly COLLIDER_RADIUS = 1;

  // Players spawn in the clear perimeter band (generated by playerSpawn, scaled to map size + count), so the
  // set is no longer a fixed 4-corner array — 2..50 players spread around the edge and advance inward.

  // renderMax/renderTotal are CPU SUBMIT time only (GPU work is async) — do NOT read them as GPU cost.
  // drawCalls/triangles + framesRendered are the honest signals: framesRendered===0 means the tab is
  // hidden (render skipped, worker-driven at 62Hz) so every fps/timing number is meaningless.
  private prof = { settleMax: 0, settleTotal: 0, settleN: 0, spawnMax: 0, rebuildMax: 0, rebuildTotal: 0, physicsMax: 0, physicsTotal: 0, gpuMax: 0, gpuTotal: 0, renderMax: 0, renderTotal: 0, colTotal: 0, colMax: 0, ctrlTotal: 0, ctrlMax: 0, projTotal: 0, projMax: 0, debrisTotal: 0, debrisMax: 0, fxTotal: 0, fxMax: 0, cpuTotal: 0, cpuMax: 0, frameTotal: 0, frameMax: 0, fpsMin: 999, drawCalls: 0, triangles: 0, framesRendered: 0, framesSimulated: 0 };
  private profZero(): typeof this.prof { return { settleMax: 0, settleTotal: 0, settleN: 0, spawnMax: 0, rebuildMax: 0, rebuildTotal: 0, physicsMax: 0, physicsTotal: 0, gpuMax: 0, gpuTotal: 0, renderMax: 0, renderTotal: 0, colTotal: 0, colMax: 0, ctrlTotal: 0, ctrlMax: 0, projTotal: 0, projMax: 0, debrisTotal: 0, debrisMax: 0, fxTotal: 0, fxMax: 0, cpuTotal: 0, cpuMax: 0, frameTotal: 0, frameMax: 0, fpsMin: 999, drawCalls: 0, triangles: 0, framesRendered: 0, framesSimulated: 0 }; }
  private perfLogT = 0;   // window timer for the per-second [PERF] console dump
  private lastHeapMB = -1; // previous window's JS heap, to log the per-window growth (allocation-rate/GC proxy)
  private readonly _dropScratch: number[] = []; // reused by streamColliders (every-frame) — no per-frame array alloc
  // Mesh streaming (Stage 2 of the render-scale plan): only the render chunks near the player are built as
  // Three.js meshes; far ones are disposed and rebuilt on return. Caps the LIVE mesh-object count (memory +
  // GC-marking) to the view bubble so the world can grow (5× buildings) at a flat object graph.
  private meshChunks = new Set<number>();      // keys of every non-empty RENDER chunk (the streaming universe)
  private readonly meshInFlight = new Set<number>(); // requested off-thread but not yet applied → don't re-request
  private readonly _meshDrop: number[] = [];   // reused far-chunk list (no per-frame alloc)

  private time = 0;
  private acc = 0;
  private lastPhysMs = 0; // last frame's physics-phase cost → adaptively caps this frame's substeps
  private last = performance.now();
  private fps = 60;

  // --- multiplayer ---
  private readonly net = new Net();
  private remotes!: RemoteDrones;
  private mode: Mode = "coop";
  private phase: "menu" | "lobby" | "playing" = "menu"; // menu → lobby (joined, picking) → playing (match live)
  private lobby: LobbyState = emptyLobby();
  private roomCode = "";
  private myRole: Role | null = null;   // chosen in the lobby; applied on begin
  private pendingMode: Mode = "coop";   // the mode we'll start (host sets it; joiners learn it from the roster)
  private mapSize: MapSize = "large";        // active map size (large = the historical full map)
  private pendingMapSize: MapSize = "large"; // host's lobby pick, synced in the begin/lobby messages
  private hosting = false;              // we created the room → we are the AI authority in co-op
  private swarm: AiSwarm | null = null; // host-only enemy AI simulation
  private aiBcast = 0;                  // seconds until the next bot-transform broadcast
  private aiWaveGap = 0;                // countdown to the next wave once the swarm is cleared
  private readonly aiBots = new Map<number, { x: number; y: number; z: number }>(); // last-known bot positions (for shooting them)
  private sessionKills = 0;     // co-op: drones the TEAM has killed this session (host-authoritative → HUD score)
  private coopHardcore = false; // co-op: permadeath (no respawns) vs respawn-while-a-teammate-lives
  private aiPrevX = 0; private aiPrevZ = 0; // host player XZ last frame → velocity estimate feeding the AI aim lead
  private readonly aiTargetBuf: AiTarget[] = [];                                   // reused each frame (no alloc)
  private readonly aiPeerBuf: { id: number; x: number; y: number; z: number; hp: number; maxHp: number }[] = []; // living human peers as AI targets (+hp for threat scoring)
  private readonly aiDropBuf: AiDrop[] = [];                                       // grenade drops emitted this tick
  private readonly aiBoomBuf: AiBoom[] = [];                                       // kamikaze contact detonations this tick
  private readonly aiBreakBuf: AiBreak[] = [];                                     // glass-break requests emitted this tick
  private readonly botBreakAt = new Map<number, number>();                         // per-bot glass-break rate limit (id → time)
  private readonly aiNoiseBuf: AiNoise[] = [];                                     // what the swarm hears this tick (footsteps/gunfire/blasts)
  private readonly recentBlasts: { x: number; z: number; t: number; loud: number }[] = []; // player explosions the swarm can still hear
  private readonly aiAimTmp = new THREE.Vector3();                                 // reused: host camera forward (bots dodge our aim)
  private minimapBig = false;                   // TAB toggles the enlarged minimap
  private readonly recentShots: RadarShot[] = []; // fading shot rays on the minimap (from peers + AI fire)
  private readonly _blips: RadarBlip[] = [];      // reused per frame by minimapFrame (objects reused in place)
  private readonly _scanMarks: { angle: number; behindWall: boolean }[] = []; // reused per frame (scan markers)
  // Missile lock-on (soldier holding the seeking-missile launcher): the drone kept inside the centre circle
  // for LOCK_TIME becomes the LOCKED target — marked on the HUD, and what the next missile hunts.
  private lockId = -1;                             // drone being acquired / held (-1 = none)
  private lockT = 0;                               // seconds it has stayed in the circle (>= LOCK_TIME → locked)
  private readonly _lockV = new THREE.Vector3();   // scratch for the 3D→screen projection
  private static readonly LOCK_TIME = 0.45;        // seconds on-target to acquire the lock (fast — drones are always moving)
  private static readonly LOCK_R = 0.26;           // lock-circle radius (NDC, aspect-corrected → a true screen circle) — big, easy to hold a mover in
  private static readonly LOCK_RANGE = 70;         // max lock distance (m)
  // Frontal scanner (R): a recharging cone pulse revealing enemies ahead (even behind walls) as fading pings.
  private scanReadyAt = 0;
  private readonly scanPings: { x: number; y: number; z: number; until: number; behindWall: boolean }[] = [];
  private readonly scanEnemyBuf: { x: number; y: number; z: number }[] = []; // reused for enemyPositions (no alloc)
  private static readonly SCAN_CD = 9;        // seconds between scans
  private static readonly SCAN_RANGE = 60;    // metres detection radius
  private static readonly SCAN_MINDOT = 0.35; // ~140° frontal cone (cos of the half-angle)
  private static readonly SCAN_LIFE = 6;      // seconds a detection stays revealed
  private static readonly SCAN_MAX = 12;      // cap detections per scan (bounds HUD markers)
  private quality: Quality = "medio";     // graphics preset (Bajo/Medio/Alto), K to cycle
  private role: Role = "drone";           // our avatar type (drone/human) — independent of the team below
  private myTeam: Team = 0;               // PvP team (0 Rojo / 1 Azul): decides friend/enemy + friendly fire
  private myClass: UnitClass = "assault"; // chosen class (stats + loadout + move); default = balanced assault
  private pendingTeam: Team = 0;          // lobby pick, applied on begin
  private pendingClass: UnitClass = "assault";
  private teamChosen = false;             // did the player explicitly pick a team? (else auto-balance by id)
  private droneKills = 0;
  private humanKills = 0;
  private matchOver = false;
  private prevDroneHp = 1;   // weakest drone-base HP last frame → base-under-attack threshold alerts
  private prevHumanHp = 1;
  private static readonly KILL_LIMIT = 15; // deathmatch limit (win also by destroying the enemy objective)
  private static readonly WAVE_CLUSTER_R = 12; // radius (m) of a wave's spawn cluster at its cardinal point
  private static readonly MATCH_GRACE = 6;     // seconds AFTER "start" before the first wave — time to get set / pick class
  private static readonly MAX_TURRETS = 2;     // active sentries a player can field at once (scarce by design)
  private static readonly DIR_LABEL: Record<Cardinal, string> = { N: "NORTE", S: "SUR", E: "ESTE", O: "OESTE" };
  private graceTick = -1;                       // last whole-second announced during the pre-wave countdown
  private hp = MAX_HP;
  private bandages = BANDAGE_MAX;  // soldier self-heal charges (refilled at base / on respawn / by medkits)
  private bandageT = 0;            // channel progress (s); reset on interrupt or completion
  private medkitNear = false;      // a live medkit is within reach (drives the HUD "pisa para recoger" cue)
  private bandaging = false;       // currently mid-channel (drives the HUD progress bar)
  private netT = 0;          // throttle for state broadcasts
  private netSent = 0;       // diagnostic: count of state messages sent
  private lastState: NetMsg | null = null; // last state sent — re-emitted by the background heartbeat
  private respawnAt = 0;     // when dead, time to respawn

  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpMuzzle = new THREE.Vector3(); // reused: viewmodel barrel-tip world pos for the muzzle flash
  private readonly tmpSpread = new THREE.Vector3(); // reused: bloom-perturbed fire direction (no per-shot allocation)
  private readonly crateGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  private readonly crateMat = new THREE.MeshStandardMaterial({ color: 0x9c6b34, roughness: 0.8, metalness: 0 });

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.gpuTimer = makeGpuTimer(this.renderer.renderer.getContext() as WebGL2RenderingContext);
    this.input = new Input(this.renderer.renderer.domElement);
    this.player = new Player(this.physics);

    this.mesher = new VoxelMesher(this.renderer.scene);
    this.collider = new VoxelCollider(this.physics);
    // Off-thread cooking: the ~80%-of-a-rebuild greedy-box cook runs in a Web Worker; the main thread only
    // turns cooked boxes into Rapier bodies. ?cook=sync forces the inline path (for A/B verification).
    this.cookService = new CookService(typeof location !== "undefined" && new URLSearchParams(location.search).get("cook") === "sync");
    this.cookService.onColliderCooked = (ck, boxes) => this.collider.applyBoxes(ck, boxes);
    this.cookService.onMeshCooked = (ck, parts) => { this.meshInFlight.delete(ck); this.mesher.applyCooked(ck, parts); };
    this.debris = new DebrisSystem(this.physics, this.renderer.scene);
    this.rubble = new RubbleField(this.renderer.scene);
    this.debris.onSettle = (x, y, z, qx, qy, qz, qw, mat) => this.rubble.deposit(x, y, z, qx, qy, qz, qw, mat);
    this.particles = new Particles(this.renderer.scene);

    let gpu: GpuParticles | null = null;
    const ptex = this.pickParticleTexSize();
    try {
      gpu = new GpuParticles(this.renderer.renderer, this.renderer.scene, ptex);
      console.info(`GPU particles activas: ${(gpu.capacity / 1e6).toFixed(2)}M`);
    } catch (e) {
      console.warn("GPU particles no disponibles, usando CPU:", e);
    }
    this.gpu = gpu;
    this.sink = gpu ?? this.particles;
    // when the GPU sink is active, keep the (empty) CPU points out of the render entirely
    if (gpu) this.particles.points.visible = false;
    this.impactMarks = new ImpactMarks(this.renderer.scene);

    // Visual settings (quality preset, resolution mode, view distance): the player's saved choice, else
    // GPU-auto-detected on first run. All render-only. The menu (O / gear) edits these live; K still cycles
    // quality. Persist so MSAA (decided at renderer creation from the "quality" key) matches next load.
    const hasSaved = typeof localStorage !== "undefined" &&
      (localStorage.getItem("visualSettings") !== null || localStorage.getItem("quality") !== null);
    this.settings = hasSaved ? loadSettings() : autoSettings(this.gpuName());
    this.quality = this.settings.quality;
    this.renderDist = this.settings.viewDist;
    this.resScale = this.settings.resAuto ? 1 : this.settings.resScale;
    saveSettings(this.settings);
    this.applyQualityPreset();
    this.renderer.setViewDistance(this.renderDist);
    if (!this.settings.resAuto) this.renderer.setRenderScale(this.resScale);

    this.targets = { grid: this.grid, debris: this.debris, particles: this.sink };
    this.projectiles = new Projectiles(
      this.physics, this.renderer.scene, this.grid,
      (x, y, z, r, p, ai, smoke) => smoke ? this.deploySmoke(x, y, z) : this.explodeAt(x, y, z, r, p, true, 0, !ai), // smoke grenade deploys a cloud (no blast); ai=no swarm friendly-fire
      (hit, dx, dy, dz) => this.onBulletHit(hit, dx, dy, dz),
    );

    this.buildGround();
    this.scenery = new Scenery(this.renderer.scene); // trees + clouds
    this.ammoCrates = new AmmoCrates(this.renderer.scene, 0x5a6b2e, 0x39461a, "models/props/crate-small.glb", 0.55); // CC0 ammo crate (box fallback)
    this.medkits = new AmmoCrates(this.renderer.scene, 0x8a2a2a, 0x5a1414, "models/props/medkit.glb", 0.4); // CC0 first-aid kit (bandage restock)
    this.viewmodel = new Viewmodel(this.renderer.scene); // first-person weapon model (shown for the soldier)
    this.baseModels = new BaseModels(this.renderer.scene); // decorative team HQ over each base
    this.initFlashes();
    buildDefaultScene(this.grid);
    this.mesher.setRingBounds(CITY_VOX.x1, CITY_VOX.z1); this.mesher.rebuild(this.grid); this.seedMeshChunks();
    this.heightField.rebuild(this.grid);
    this.gpu?.setHeightField(this.heightField.texture, this.heightField.origin, this.heightField.size);
    this.rebuildGasTanks();
    this.spawnInitialProps();
    this.spawnPlayerInBuilding();
    this.streamColliders(true); // build only the building colliders near the player (collision LOD)
    // Warm the GPU particle pipelines (soft points + LOD cubes) at load: a few debris near the
    // camera force the driver to compile/optimise those draw pipelines now, so the first real
    // blast doesn't pay a one-time ~150ms shader-compile stall mid-game.
    const wc = this.player.camera.position;
    this.sink.burst(wc.x, wc.y, wc.z, { count: 0, color: 0, speed: 1, life: 0.6, kind: "debris", colorType: 0.61, strength: 0.03 });

    this.hud.setTool(this.tool);
    this.hud.setMaterial(MATERIAL_ORDER[this.matIndex]);
    this.hud.onGear(() => this.openSettings()); // gear button ≡ the O key
    this.hud.onGameOver({ restart: () => this.restartMatch(), menu: () => location.reload() }); // end-of-match: replay or menu

    this.input.onMouseDown = (b) => this.onMouseDown(b);
    this.input.onMouseUp = (b) => { if (b === 0) this.firing = false; if (b === 2) this.ads = false; }; // LMB→stop fire, RMB→unscope
    this.input.onWheel = (s) => this.onWheel(s);
    this.input.onKey = (c) => this.onKey(c);

    this.remotes = new RemoteDrones(this.renderer.scene, this.physics);
    this.net.onMessage = (m) => this.onNet(m);
    this.setupModeMenu();
  }

  /** Start menu: pick Libre (sandbox) or VS (PvP — only weapons, drones take damage), then join a
   *  multiplayer room. Players in the same room see and (in VS) can damage each other. */
  private setupModeMenu(): void {
    const params = new URLSearchParams(location.search);
    const urlMode = params.get("mode");
    if (urlMode === "coop" || urlMode === "dvh" || urlMode === "vs" || urlMode === "free") {
      // headless/test path: straight into the match, no lobby.
      const room = params.get("room") || "lobby";
      this.mode = this.pendingMode = urlMode; this.roomCode = room;
      this.rebuildWorld(hashStr(room), false);
      this.net.connect(room);
      this.phase = "playing";
      this.hud.setMode(urlMode, room);
      this.camFx.setRole("drone");
      this.hud.setHealth(this.hp, this.myMaxHp(), true);
      return;
    }
    this.hud.showModeMenu({ create: (mode) => this.createRoom(mode), join: (code) => this.joinRoom(code) });
  }

  // --- lobby --------------------------------------------------------------

  /** Create a room in `mode`: you're the host (own the AI in co-op) and get a random shareable code. */
  private createRoom(mode: Mode): void { this.hosting = true; this.enterLobby(mode, makeRoomCode()); }
  /** Join by code — the mode is learned from the host's roster broadcast; the host owns the AI. */
  private joinRoom(code: string): void { this.hosting = false; this.enterLobby(null, code); }

  private enterLobby(mode: Mode | null, code: string): void {
    this.roomCode = code;
    this.pendingMode = mode ?? "coop";                     // provisional until a peer's roster tells us
    this.myRole = mode === "coop" ? "human" : null;        // co-op: everyone's a soldier; PvP: pick in the lobby
    this.lobby = emptyLobby();
    this.phase = "lobby";
    this.net.connect(code);
    this.showLobbyUi();
    this.audio.ui();
  }

  private showLobbyUi(): void {
    this.hud.showLobby(this.roomCode, this.pendingMode, {
      pick: (r) => this.lobbyPick(r),
      start: () => this.hostStart(),
      leave: () => location.reload(),
      toggleHardcore: () => { this.coopHardcore = !this.coopHardcore; this.hud.setHardcore(this.coopHardcore); },
      pickTeam: (t) => this.lobbyPickTeam(t),
      pickClass: (c) => this.lobbyPickClass(c),
      pickMapSize: (s) => this.lobbyPickMapSize(s),
    });
    this.hud.setHardcore(this.coopHardcore); // reflect the current death rule on the toggle
    this.refreshLobby();
  }

  /** Re-announce our presence (id, chosen role, mode) so the roster converges on every client. */
  private broadcastLobby(): void {
    this.lobby = applyJoin(this.lobby, this.net.id, this.myRole);
    if (!this.teamChosen) this.pendingTeam = this.autoTeam(); // show the auto-balanced team until they pick
    if (this.net.connected) this.net.send({ t: "lobby", role: this.myRole, mode: this.pendingMode, map: this.pendingMapSize });
    this.refreshLobby();
  }

  private lobbyPick(role: Role): void {
    this.myRole = role;
    this.pendingClass = defaultClass(role); // switching type resets to that side's balanced default class
    this.lobby = applyPick(this.lobby, this.net.id, role);
    this.broadcastLobby();
  }

  /** PvP: choose Rojo/Azul (independent of the drone/soldier type). */
  private lobbyPickTeam(team: Team): void {
    this.pendingTeam = team; this.teamChosen = true;
    this.audio.ui(); this.refreshLobby();
  }

  /** PvP: choose the class within the chosen type (validated against the role at apply-time). */
  private lobbyPickClass(cls: string): void {
    this.pendingClass = cls as UnitClass;
    this.audio.ui(); this.refreshLobby();
  }

  /** Host-only: choose the map size preset; broadcast so every joiner learns it before start. */
  private lobbyPickMapSize(size: string): void {
    if (!MAP_SIZES[size as MapSize]) return;
    this.pendingMapSize = size as MapSize;
    this.audio.ui(); this.broadcastLobby();
  }

  private hostStart(): void {
    if (this.net.id !== (hostOf(this.lobby) ?? this.net.id)) return; // only the host may start
    this.net.send({ t: "begin", mode: this.pendingMode, hardcore: this.coopHardcore, map: this.pendingMapSize }); // share mode + death rule + map size
    this.beginMatch();
  }

  /** "Jugar de nuevo" from the game-over overlay. The HOST (or a solo/offline player) re-broadcasts `begin`
   *  so every client replays the SAME room in sync (host-authoritative, deterministic seed) and rebuilds
   *  locally. A non-host joiner can't restart the shared match alone → it drops back to the lobby to await
   *  the host's next start. Only fires while the match is over (the overlay is the only caller). */
  private restartMatch(): void {
    const isHost = this.net.id === (hostOf(this.lobby) ?? this.net.id); // solo/offline → hostOf falls back to us
    if (isHost) {
      if (this.net.connected) this.net.send({ t: "begin", mode: this.pendingMode, hardcore: this.coopHardcore, map: this.pendingMapSize });
      this.beginMatch();
    } else {
      this.matchOver = false; // leave the frozen game-over state; wait in the lobby for the host to begin
      this.hud.hideWin(); this.hud.hideDeath();
      this.phase = "lobby";
      this.showLobbyUi();
      this.hud.flash("Esperando al anfitrión…");
    }
  }

  private refreshLobby(): void {
    if (this.phase !== "lobby") return;
    const host = hostOf(this.lobby) ?? this.net.id;
    this.hud.updateLobby(this.lobby.players.map((p) => ({ id: p.id, role: p.role })), this.net.id, host, this.myRole, this.pendingTeam, this.pendingClass, this.pendingMapSize, this.pendingMode);
  }

  /** Everyone runs this on the host's "begin": build the shared seed-world + spawn with the chosen role. */
  private beginMatch(): void {
    if (!canBeginMatch(this.phase, this.matchOver)) return; // block a duplicate begin mid-fight; allow a restart once over
    this.mode = this.pendingMode;
    this.mapSize = this.pendingMapSize; // apply the agreed map size BEFORE the world is built
    this.rebuildWorld(hashStr(this.roomCode), false);
    this.phase = "playing";
    this.hud.hideLobby();
    this.hud.hideWin(); this.hud.hideDeath(); // clear any prior game-over/death overlay on a replay (idempotent on a first start)
    this.resetTransientCombatState();
    this.bandages = BANDAGE_MAX;              // fresh match → full bandages
    this.hud.setMode(this.mode, this.roomCode);
    // team: co-op is one team vs the AI; dvh derives it from the role (the side IS the role, so FF/spawn/
    // radar/scoring all share one axis); free vs honours the Rojo/Azul pick, else auto-balances
    this.myTeam = this.mode === "coop" ? 0 : this.mode === "dvh" ? teamForRole(this.myRole ?? "human") : (this.teamChosen ? this.pendingTeam : this.autoTeam());
    this.myClass = this.pendingClass;
    this.applyChosenRole(this.mode === "coop" ? "human" : (this.myRole ?? "human"), this.pendingClass);
    this.spawnPlayerInBuilding();
    this.net.send({ t: "needsync" });
    if (this.mode === "coop") { // fresh survival session: reset the score/deaths, clear any prior game-over
      this.sessionKills = 0; this.myDeaths = 0; this.matchOver = false;
      this.hud.hideWin(); this.hud.hideDeath();
      for (const id of this.aiBots.keys()) this.remotes.remove(-id); // drop last match's bot avatars so they don't ghost (mesh + radar) into the replay
      this.aiBots.clear();
      this.botBreakAt.clear(); // fresh swarm reuses ids from 1 → drop stale break timers
      this.clearTurrets();     // no sentries carried over from a prior run
      this.graceTick = -1;
      // host owns the enemy AI; hold the first wave for a grace window so everyone can get set (pick class, orient)
      if (this.hosting) { this.swarm = new AiSwarm(); this.aiWaveGap = Game.MATCH_GRACE; }
    }
    this.audio.ui();
  }

  // --- enemy AI (co-op) ----------------------------------------------------

  /** Per-frame AI. The HOST simulates the swarm (spawn waves, seek, fire), broadcasts bot transforms and
   *  renders them; peers only render from the broadcast. Bots target the host soldier (peer-targeting later). */
  private aiFrame(dt: number): void {
    if (this.mode !== "coop") return;
    const s = this.swarm;
    if (this.hosting && s && !this.matchOver) {
      const cp = this.player.camera.position;
      if (s.count === 0) {
        this.aiWaveGap -= dt;
        if (s.wave === 0 && this.aiWaveGap > 0) { // opening grace: tick a per-second "get ready" countdown on the HUD
          const secs = Math.ceil(this.aiWaveGap);
          if (secs !== this.graceTick) { this.graceTick = secs; this.hud.flash(`⏳ Primera oleada en ${secs}…`); }
        }
        if (this.aiWaveGap <= 0) { // each wave enters from ONE cardinal side, from BEYOND the barricade
          // spawn just past the treeline — but CAP the margin to ~a third of the map's short side, so a MICRO/small
          // arena doesn't fling the wave far out into the void (the forest ring is a FIXED ~28 m band, disproportionate
          // to a tiny map). Large/medium keep the full margin; micro pulls the wave in close to the arena.
          const beyond = Math.min(FOREST_RING.hedgeInset + FOREST_RING.treeGap + FOREST_RING.depth + 12, Math.round(Math.min(CITY_VOX.x1, CITY_VOX.z1) * 0.35));
          // wave 0: the players are still pinned in the perimeter band, so the rotation's N side would drop the
          // swarm right on the host — steer the OPENING wave to the cardinal farthest from him. Later waves keep
          // the N→S→E→O rotation (by then everyone has moved inward, so every side reads as "far").
          const dir = s.wave === 0 ? farthestCardinal(cp.x, cp.z, CITY_VOX.x1, CITY_VOX.z1, VOXEL, beyond) : WAVE_DIRS[((s.wave % 4) + 4) % 4];
          const c = cardinalPoint(dir, CITY_VOX.x1, CITY_VOX.z1, VOXEL, beyond);
          s.spawnWave(c.cx, c.cz, Game.WAVE_CLUSTER_R, 20);                 // small radius → a tight cluster, spawned high to clear the trees
          s.seedContact(CITY_VOX.x1 * 0.5 * VOXEL, CITY_VOX.z1 * 0.5 * VOXEL); // advance toward the city centre until a bot perceives you
          this.hud.flash(`⚠ Oleada ${s.wave} — desde el ${Game.DIR_LABEL[dir]}`);
        }
      } else this.aiWaveGap = 2.5; // BRUTAL: relentless — the next wave crowds in fast once the swarm thins
      // Targets = every LIVING player (host + human peers) — the swarm chases them ALL, not just the host. The
      // host is led by its own velocity for tighter aim; peers unled. LOS is injected so bots flank cover and
      // never fire through walls (the sim only emits a shot when the firing bot can see its chosen target).
      const targets = this.aiTargetBuf; targets.length = 0;
      if (this.hp > 0) {
        const vx = (cp.x - this.aiPrevX) / Math.max(dt, 1e-3), vz = (cp.z - this.aiPrevZ) / Math.max(dt, 1e-3);
        this.player.camera.getWorldDirection(this.aiAimTmp); // our look dir → bots dodge when we aim at them
        targets.push({ id: this.net.id, x: cp.x, y: cp.y, z: cp.z, vx, vz, hp: this.hp, maxHp: this.myMaxHp(), firing: this.firing, aimX: this.aiAimTmp.x, aimZ: this.aiAimTmp.z });
      }
      this.aiPrevX = cp.x; this.aiPrevZ = cp.z;
      this.remotes.humanTargets(this.aiPeerBuf);
      for (const p of this.aiPeerBuf) targets.push(p);
      // NOISE the swarm can hear (host soldier v1): footsteps (quieter when crouched/prone, louder running; none
      // when still), gunfire, and recent player explosions. This is WHAT reveals you — quiet + hidden = harder to find.
      const noises = this.aiNoiseBuf; noises.length = 0;
      if (this.hp > 0 && this.player instanceof Walker) {
        const inp = this.input;
        if (inp.isDown("keyw") || inp.isDown("keya") || inp.isDown("keys") || inp.isDown("keyd")) {
          const run = inp.isDown("shiftleft") || inp.isDown("shiftright");
          const st = this.player.stanceVal;
          noises.push({ x: cp.x, z: cp.z, loud: st >= 2 ? 4 : st === 1 ? 7 : run ? 18 : 11 }); // footsteps
        }
        if (this.firing) noises.push({ x: cp.x, z: cp.z, loud: 40 }); // gunfire gives you away
      }
      for (let i = this.recentBlasts.length - 1; i >= 0; i--) { // player explosions echo for ~0.6 s
        const rb = this.recentBlasts[i];
        if (this.time - rb.t > 0.6) { this.recentBlasts.splice(i, 1); continue; }
        noises.push({ x: rb.x, z: rb.z, loud: rb.loud });
      }
      const drops = this.aiDropBuf; drops.length = 0;
      const booms = this.aiBoomBuf; booms.length = 0;
      const breaks = this.aiBreakBuf; breaks.length = 0;
      for (const f of s.tick(dt, targets, (bx, by, bz, tx, ty, tz) => this.aiCanSee(bx, by, bz, tx, ty, tz), Math.random, drops, booms,
        (x, y, z) => this.grid.has(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL)), noises, breaks)) // collide + hear + break-requests
        this.aiShoot(f.x, f.y, f.z, f.dx, f.dy, f.dz, f.targetId, f.dmg, f.blind);
      for (const g of drops) this.aiDropGrenade(g.x, g.y, g.z); // bombers release falling grenades
      for (const g of booms) this.aiDetonate(g);                // kamikazes reach the target and self-destruct
      for (const g of breaks) this.aiBreakGlass(g);             // drones shatter a window to get inside
      this.aiBots.clear();
      for (const b of s.list) this.aiBots.set(b.id, { x: b.x, y: b.y, z: b.z });
      this.hud.setCoopScore(this.sessionKills, s.wave);
      this.checkTeamWipe(); // all players down → end the session
      this.aiBcast -= dt;
      if (this.aiBcast <= 0 && this.net.connected) {
        this.aiBcast = 0.07;
        this.net.send({ t: "ai", b: s.list.map((b) => [b.id, +b.x.toFixed(2), +b.y.toFixed(2), +b.z.toFixed(2)]), k: this.sessionKills, w: s.wave });
      }
    }
    this.renderBots();
  }

  /** Draws every known bot as a remote drone avatar under a synthetic NEGATIVE id (never collides with peers). */
  private renderBots(): void {
    for (const [id, p] of this.aiBots) this.remotes.upsert(-id, p.x, p.y, p.z, 0, 0, 0, 1, 100, "drone", 100, 0, 0, 0);
  }

  /** Host-only: end the co-op session the moment EVERY soldier (host + human peers) is down (team wipe). */
  private checkTeamWipe(): void {
    if (this.matchOver) return;
    if (this.hp > 0) return; // the wipe list includes our own hp → alive means not wiped (skip the peer scan)
    for (const p of this.remotes.peers()) if (p.isHuman && p.hp > 0) return;
    this.endCoop();
  }

  /** End the co-op session: freeze the swarm, show the game-over overlay + final score, tell everyone. */
  private endCoop(): void {
    this.matchOver = true;
    const wave = this.swarm?.wave ?? 0;
    this.hud.hideDeath();
    this.hud.showGameOver(this.sessionKills, wave);
    this.releaseCursor();
    this.audio.death(true);
    if (this.net.connected) this.net.send({ t: "coopover", k: this.sessionKills, w: wave });
  }

  /** Frees the pointer lock so the mouse cursor reappears — used when a full-screen overlay with clickable
   *  controls goes up (game-over, settings), otherwise the locked cursor can't reach the buttons. */
  private releaseCursor(): void {
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
  }

  /** A bot fires: muzzle flash (broadcast so all see it) + host-authoritative chip damage to its target
   *  (dodgeable — break line of sight to avoid the next shot). */
  private aiShoot(x: number, y: number, z: number, dx: number, dy: number, dz: number, targetId: number, dmg: number, blind = false): void {
    this.muzzleFlash(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz), 0.3);
    if (this.net.connected) this.net.send({ t: "aifire", x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1), dx: +dx.toFixed(2), dy: +dy.toFixed(2), dz: +dz.toFixed(2) });
    // The emitted aim (lead + spread) DECIDES the hit — one pure model (aiShotDamage) for host and
    // peers, so strafing actually dodges shots and both players eat identical fire.
    if (targetId === this.net.id) {
      // BLIND suppression only chips us if the bot can ACTUALLY see us — no through-wall damage (pure pressure).
      const p = this.player.camera.position;
      const sees = !blind || this.aiCanSee(x, y, z, p.x, p.y, p.z);
      const hit = this.hp > 0 ? aiShotDamage(x, y, z, dx, dy, dz, p.x, p.y, p.z, sees, dmg) : 0; // per-archetype base, wave-scaled
      if (hit > 0) this.damageDrone(hit, x, z);
    } else if (this.net.connected && !blind) { // peer target: only confirmed (sighted) shots deal damage
      const tgt = this.aiTargetBuf.find((t) => t.id === targetId); // filled this frame right before s.tick() → valid here
      if (!tgt) return;
      const hit = aiShotDamage(x, y, z, dx, dy, dz, tgt.x, tgt.y, tgt.z, true, dmg); // non-blind peer shot → already sighted; same per-archetype base
      if (hit > 0) this.net.send({ t: "aihit", to: targetId, dmg: hit, x: +x.toFixed(1), z: +z.toFixed(1) });
    }
  }

  /** A bomber drone RELEASES a grenade at (x,y,z) — it falls under gravity ("suelta, no tirada") and detonates
   *  below, carving cover + hurting players but NOT the swarm (the `ai` flag skips bot friendly-fire). Host-
   *  authoritative; peers get a ghost falling grenade via `aidrop`, and the blast via the `explode` broadcast. */
  private aiDropGrenade(x: number, y: number, z: number): void {
    this.projectiles.launchGrenade(new THREE.Vector3(x, y - 0.4, z), new THREE.Vector3(0, -1, 0), 1.5, false, 1, true);
    if (this.net.connected) this.net.send({ t: "aidrop", x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1) });
  }

  /** A KAMIKAZE reached its target and self-destructs: an immediate area blast (carves cover, no bot friendly-
   *  fire) + a hard hit on the target + wreckage. Host-authoritative; peers replay the blast (`explode`) and
   *  drop the avatar (`aiboom`). The bot was already removed from the swarm by the sim. */
  private aiDetonate(g: AiBoom): void {
    this.explodeAt(g.x, g.y, g.z, 3.2, 1.4, this.net.connected, 0, false);
    this.droneDeathFx(g.x, g.y, g.z);
    this.aiBots.delete(g.id);
    this.remotes.remove(-g.id);
    if (g.targetId === this.net.id) { if (this.hp > 0) this.damageDrone(30, g.x, g.z); }
    else if (this.net.connected) this.net.send({ t: "aihit", to: g.targetId, dmg: 30, x: +g.x.toFixed(1), z: +g.z.toFixed(1) });
    if (this.net.connected) this.net.send({ t: "aiboom", bot: g.id, x: +g.x.toFixed(1), y: +g.y.toFixed(1), z: +g.z.toFixed(1) });
  }

  /** A drone pressed against a wall on its way inside asked to clear the voxel just ahead. The host breaks it
   *  ONLY if it's glass (a window) — never concrete — rate-limited per bot so a swarm doesn't atomize a whole
   *  wall. Reuses the exact bullet-hit destruction path (`hit` broadcast + `applyBulletHit`) so it inherits the
   *  deterministic debris seed, the `removedSinceGen` late-join sync, and peer replay — no new net message. */
  private aiBreakGlass(g: AiBreak): void {
    if (this.time - (this.botBreakAt.get(g.id) ?? -1) < 0.4) return;   // ≤ 1 pane / bot / 0.4 s
    const [vx, vy, vz] = VoxelGrid.worldToVoxel(g.x, g.y, g.z);
    if (this.grid.get(vx, vy, vz) !== "glass") return;                 // windows only — never chew through concrete
    this.botBreakAt.set(g.id, this.time);
    const c = VoxelGrid.center(vx, vy, vz);
    const nx = -g.dx, nz = -g.dz;                                      // face normal points back toward the bot
    if (this.net.connected) this.net.send({
      t: "hit", vx, vy, vz, dx: +g.dx.toFixed(3), dy: 0, dz: +g.dz.toFixed(3),
      px: +c.x.toFixed(2), py: +c.y.toFixed(2), pz: +c.z.toFixed(2), nx: +nx.toFixed(2), ny: 0, nz: +nz.toFixed(2),
    });
    this.applyBulletHit(vx, vy, vz, g.dx, 0, g.dz, c.x, c.y, c.z, nx, 0, nz);
  }

  /** True if the straight line from a bot to a target is clear of solid voxels — so a bot can only shoot
   *  the player when it actually has line of sight (no firing through walls). Uses the grid raycast. */
  private aiCanSee(bx: number, by: number, bz: number, tx: number, ty: number, tz: number): boolean {
    const dx = tx - bx, dy = ty - by, dz = tz - bz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return true;
    const hit = this.grid.raycast(bx, by, bz, dx, dy, dz, dist);
    if (hit !== null && hit.distance < dist - 0.6) return false;       // a wall blocks the sightline
    return !this.smokeBlocks(bx, by, bz, tx, ty, tz);                  // …and so does a smoke cloud on the line
  }

  /** True if an active smoke cloud sits on the sightline a→b — blocks line of sight in BOTH directions. */
  private smokeBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.smokeClouds.length > 0 && smokeOccludes(this.smokeClouds, this.time, ax, ay, az, bx, by, bz);
  }

  /** Adds a smoke cloud (LOS-blocking sphere + an initial visual puff). Shared by the thrower + the `smoke` msg. */
  private addSmoke(x: number, y: number, z: number): void {
    this.smokeClouds.push({ x, y, z, r: 7, until: this.time + 10 });
    this.sink.burst(x, y, z, { count: 26, color: 0x9a9a9a, speed: 2.2, size: 14, life: 3.2, buoyancy: 0.6, windCoupling: 0.3, spread: 1.6, kind: "smoke", strength: 0.04 });
  }

  /** The thrown smoke grenade detonated (host or peer): deploy the cloud locally + tell everyone. */
  private deploySmoke(x: number, y: number, z: number): void {
    this.addSmoke(x, y, z);
    this.audio.ui();
    if (this.net.connected) this.net.send({ t: "smoke", x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1) });
  }

  /** Per-frame: drop expired clouds and keep each active one visually filled (a sustained ~10 s cloud). */
  private smokeFrame(): void {
    if (this.smokeClouds.length === 0) return;
    for (let i = this.smokeClouds.length - 1; i >= 0; i--) if (this.smokeClouds[i].until <= this.time) this.smokeClouds.splice(i, 1);
    if (this.smokeClouds.length === 0 || this.time < this.smokeFxAt) return;
    this.smokeFxAt = this.time + 0.25;
    for (const c of this.smokeClouds) this.sink.burst(c.x, c.y + 1, c.z, { count: 8, color: 0x9a9a9a, speed: 1.4, size: 13, life: 2.6, buoyancy: 0.5, windCoupling: 0.3, spread: 1.5, kind: "smoke", strength: 0.03 });
  }

  /** Launch the interceptor SWARM (replaces the net): ~5 homing mini-drones pop out of the soldier, each hunts
   *  the nearest enemy drone, rams it and detonates. Local visual; the KILL is host-authoritative. */
  private fireSwarm(origin: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 5; i++) {
      const jx = (Math.random() - 0.5) * 1.4, jz = (Math.random() - 0.5) * 1.4;
      const mesh = new THREE.Mesh(this.miniGeo, this.miniMat);
      mesh.position.set(origin.x + jx, origin.y - 0.2, origin.z + jz);
      this.renderer.scene.add(mesh);
      this.miniDrones.push({ mesh, x: origin.x + jx, y: origin.y - 0.2, z: origin.z + jz, vx: dir.x * 6 + jx * 3, vy: 3.5 + Math.random() * 2, vz: dir.z * 6 + jz * 3, life: 6 });
    }
    this.audio.ui();
  }

  /** Per-frame: each interceptor homes on the nearest enemy drone; on contact it kills it + a spark burst.
   *  A killed bot is dropped from THIS frame's snapshot so two interceptors don't waste on the same drone. */
  private miniDroneFrame(dt: number): void {
    if (this.miniDrones.length === 0) return;
    const bots = this._miniBots; bots.length = 0;
    for (const [id, p] of this.aiBots) {
      let b = this._miniBotPool[bots.length];
      if (!b) { b = { id: 0, x: 0, y: 0, z: 0 }; this._miniBotPool[bots.length] = b; }
      b.id = id; b.x = p.x; b.y = p.y; b.z = p.z;
      bots.push(b);
    }
    for (let i = this.miniDrones.length - 1; i >= 0; i--) {
      const m = this.miniDrones[i];
      m.life -= dt;
      let ti = -1;
      if (bots.length > 0) {
        if (m.boom) {
          // ONLY homes to the LOCKED target — with no lock (or once it's gone) the missile flies STRAIGHT, never re-picks
          if (m.target !== undefined) for (let j = 0; j < bots.length; j++) if (bots[j].id === m.target) { ti = j; break; }
        } else ti = pickTarget(m.x, m.z, bots); // interceptors keep hunting the nearest each frame
      }
      if (ti >= 0) {
        const t = bots[ti];
        const s = m.boom
          ? homingStep(m.x, m.y, m.z, m.vx, m.vy, m.vz, t.x, t.y, t.z, 150, 78, dt) // missile: HARD turn + high speed so it actually connects
          : homingStep(m.x, m.y, m.z, m.vx, m.vy, m.vz, t.x, t.y, t.z, 60, 42, dt);  // interceptors: catch fast late-wave drones
        m.x = s.x; m.y = s.y; m.z = s.z; m.vx = s.vx; m.vy = s.vy; m.vz = s.vz;
        const rx = t.x - m.x, ry = t.y - m.y, rz = t.z - m.z;
        if (rx * rx + ry * ry + rz * rz < (m.boom ? 9 : 2.25)) { // reached it (missile = 3 m, no tunnel at high speed)
          if (m.boom) this.explodeAt(m.x, m.y, m.z, 4, 700, true); // lock-on MISSILE → AoE airburst (catches the cluster)
          else { this.sink.burst(m.x, m.y, m.z, { count: 10, color: 0x88ffdd, speed: 7, size: 4, life: 0.3, kind: "spark", strength: 0.02 }); this.killBot(t.id); }
          bots.splice(ti, 1); // don't let another interceptor chase the corpse this frame
          this.despawnMini(i);
          continue;
        }
      } else { // nothing to hunt: an interceptor coasts + drops + expires faster; a lock-less MISSILE flies STRAIGHT its full range
        m.x += m.vx * dt; m.y += m.vy * dt; m.z += m.vz * dt;
        if (!m.boom) { m.vy -= 6 * dt; m.life -= dt; }
      }
      // MISSILE detonates on impact with the WORLD (walls / buildings), not only on reaching a drone → a boom + crater
      if (m.boom && this.grid.has(Math.floor(m.x / VOXEL), Math.floor(m.y / VOXEL), Math.floor(m.z / VOXEL))) {
        this.explodeAt(m.x, m.y, m.z, 4, 700, true);
        this.despawnMini(i);
        continue;
      }
      m.mesh.position.set(m.x, m.y, m.z);
      if (m.boom) m.mesh.lookAt(m.x + m.vx, m.y + m.vy, m.z + m.vz); // nose (+Z) leads the velocity
      if (m.life <= 0) this.despawnMini(i);
    }
  }

  private despawnMini(i: number): void {
    this.renderer.scene.remove(this.miniDrones[i].mesh);
    this.miniDrones.splice(i, 1);
  }

  /** A restart must not inherit the old match's combat leftovers: mini-drone meshes would ghost in the
   *  scene, a held LMB/RMB would fire/scope on spawn, and stale lock/chain/radar state would replay. */
  private resetTransientCombatState(): void {
    for (let i = this.miniDrones.length - 1; i >= 0; i--) this.despawnMini(i);
    this.tankChain.length = 0;
    this.recentShots.length = 0;
    this.scanPings.length = 0;
    this.lockId = -1; this.lockT = 0; this.hud.setLock(false, null);
    this.firing = false; this.ads = false;
    this.bloom = 0; this.lastBloomT = 0;
    this.reloadingUntil = 0; // no reload lock carries into a fresh match
  }

  /** Missile lock-on: while the soldier holds the seeking-missile launcher, the drone kept inside the centre
   *  circle for LOCK_TIME becomes the LOCKED target (marked on the HUD). fireLockon sends the missile at it. */
  private lockFrame(dt: number): void {
    const on = this.mode !== "free" && this.role === "human" && this.weapon === "lockon" && this.aiBots.size > 0;
    if (!on) { if (this.lockId !== -1) { this.lockId = -1; this.lockT = 0; } this.hud.setLock(false, null); return; }
    const cam = this.player.camera; cam.updateMatrixWorld();
    const cp = cam.position, aspect = window.innerWidth / Math.max(1, window.innerHeight);
    let best = -1, bestR = Game.LOCK_R, bx = 0, by = 0, bz = 0;                       // the drone nearest the crosshair, inside the circle
    for (const [id, p] of this.aiBots) {
      const dx = p.x - cp.x, dy = p.y - cp.y, dz = p.z - cp.z;
      if (dx * dx + dy * dy + dz * dz > Game.LOCK_RANGE * Game.LOCK_RANGE) continue;
      const ndc = this._lockV.set(p.x, p.y, p.z).project(cam);
      if (ndc.z > 1) continue;                                                        // behind the camera
      const r = Math.hypot(ndc.x * aspect, ndc.y);                                    // aspect-corrected → a true screen circle
      if (r < bestR) { bestR = r; best = id; bx = p.x; by = p.y; bz = p.z; }
    }
    if (best === -1) { this.lockId = -1; this.lockT = 0; this.hud.setLock(true, null); return; } // aim off all → circle only
    if (best === this.lockId) this.lockT += dt; else { this.lockId = best; this.lockT = 0; }     // hold → acquire; switch → restart
    const ndc = this._lockV.set(bx, by, bz).project(cam);
    this.hud.setLock(true, { x: (ndc.x * 0.5 + 0.5) * 100, y: (-ndc.y * 0.5 + 0.5) * 100, progress: Math.min(1, this.lockT / Game.LOCK_TIME), locked: this.lockT >= Game.LOCK_TIME });
  }

  /** Instakill a bot rammed by an interceptor (host-authoritative; a peer reports it for the host to apply). */
  private killBot(id: number): void {
    if (this.hosting && this.swarm) { if (this.swarm.damageBot(id, 99)) this.onBotDead(id); }
    else if (this.net.connected) this.net.send({ t: "aihitbot", bot: id, dmg: 99 });
  }

  /** Distance ALONG the aim ray to the nearest bot within `radius` of the line, or null. For airburst weapons. */
  private nearestBotDistOnRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, radius: number): number | null {
    let best = -1; const r2 = radius * radius;
    for (const p of this.aiBots.values()) {
      const wx = p.x - ox, wy = p.y - oy, wz = p.z - oz, t = wx * dx + wy * dy + wz * dz;
      if (t < 1 || t > range) continue;
      const cx = ox + dx * t - p.x, cy = oy + dy * t - p.y, cz = oz + dz * t - p.z;
      if (cx * cx + cy * cy + cz * cz < r2 && (best < 0 || t < best)) best = t;
    }
    return best < 0 ? null : best;
  }

  /** Flak cannon: an AIRBURST among the drones you aim at (or at a fixed reach) — big AoE vs the clustered swarm. */
  private fireFlak(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const D = this.nearestBotDistOnRay(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 50, 4) ?? 30;
    this.explodeAt(origin.x + dir.x * D, origin.y + dir.y * D, origin.z + dir.z * D, 5, 850, true);
    this.trauma = addTrauma(this.trauma, 0.08);
  }

  /** EMP grenade: an electric burst that DISABLES every drone in radius for a few seconds (host-authoritative). */
  private fireEmp(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const D = this.nearestBotDistOnRay(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 45, 5) ?? 26;
    const bx = origin.x + dir.x * D, by = origin.y + dir.y * D, bz = origin.z + dir.z * D;
    this.addFlash(bx, by, bz, 1.4);
    this.sink.burst(bx, by, bz, { count: 20, color: 0x66ccff, speed: 8, size: 6, life: 0.5, buoyancy: 0, windCoupling: 0.1, kind: "spark", strength: 0.02 });
    this.audio.scan();
    if (this.hosting && this.swarm) this.swarm.stunBots(bx, bz, 9, 3.2); // 9 m radius, 3.2 s disable
    else if (this.net.connected) this.net.send({ t: "aistun", x: bx, z: bz, r: 9, dur: 3.2 }); // peer → host applies the stun (mirrors aihitbot)
  }

  /** Lock-on missile: a fast homing round (reuses the interceptor system) that hunts the nearest drone and
   *  AIRBURSTS on contact (a small AoE that also catches its neighbours). */
  private fireLockon(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const mesh = this.makeMissile();
    mesh.position.set(origin.x, origin.y - 0.2, origin.z);
    this.renderer.scene.add(mesh);
    // seek ONLY a completed lock (drone held in the circle for LOCK_TIME); no lock → the missile flies straight.
    const locked = this.lockT >= Game.LOCK_TIME && this.lockId >= 0;
    this.miniDrones.push({ mesh, x: origin.x, y: origin.y - 0.2, z: origin.z, vx: dir.x * 34, vy: dir.y * 34 + 1, vz: dir.z * 34, life: 5, boom: true, target: locked ? this.lockId : undefined });
    this.audio.shot("glauncher");
  }

  /** Assembles the lock-on missile from the shared ms* geos/mats (scene.remove-only cleanup):
   *  grey body, red-hot nose at +Z, four dark tail fins and a glowing exhaust at −Z. */
  private makeMissile(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.msBodyGeo, this.msBodyMat);
    body.castShadow = true;
    const nose = new THREE.Mesh(this.msNoseGeo, this.msNoseMat);
    nose.position.z = 0.23;
    nose.castShadow = true;
    const glow = new THREE.Mesh(this.msGlowGeo, this.msGlowMat);
    glow.position.z = -0.19;
    g.add(body, nose, glow);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const fin = new THREE.Mesh(this.msFinGeo, this.msFinMat);
      fin.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, -0.12);
      fin.rotation.z = a - Math.PI / 2;
      fin.castShadow = true;
      g.add(fin);
    }
    return g;
  }

  /** Deploy a SENTRY turret just ahead — it auto-fires at nearby drones for ~26 s so you don't face the swarm
   *  alone. Co-op is where it earns its keep (there are bots to shoot); in PvP it just sits (no AI swarm). */
  private deployTurret(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const tx = origin.x + dir.x * 3, tz = origin.z + dir.z * 3, ty = origin.y - 1.45; // = the player's FEET → the foot sits flush ON the ground, not floating
    const M = this.turretMat, g = new THREE.Group();
    // static pedestal: a splayed hex foot + a tapered post (never tilts — only the head above tracks)
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.58, 0.14, 6), M); foot.position.y = 0.07;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 0.42, 8), M); post.position.y = 0.35;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 8), M); collar.position.y = 0.58;
    foot.castShadow = post.castShadow = true;
    g.add(foot, post, collar);
    // rotating head: armored housing, a mantlet, twin barrels (point +Z → lookAt aims them at the drone) and a sensor eye
    const head = new THREE.Group(); head.position.y = 0.66; head.rotation.order = "YXZ"; // yaw (Y) then pitch (X) → clean turret aim
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.36), M);
    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.16), M); mantlet.position.z = 0.24;
    const barrelL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.74), M); barrelL.position.set(-0.1, 0.01, 0.55);
    const barrelR = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.74), M); barrelR.position.set(0.1, 0.01, 0.55);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.04), this.turretAccentMat); eye.position.set(0, 0.15, 0.2);
    body.castShadow = true;
    head.add(body, mantlet, barrelL, barrelR, eye);
    g.add(head); g.position.set(tx, ty, tz);
    this.renderer.scene.add(g);
    this.turrets.push({ mesh: g, head, x: tx, y: ty + 0.66, z: tz, cd: 0, until: this.time + 26, yaw: Math.atan2(dir.x, dir.z), pitch: 0 });
    this.hud.flash("🗼 Torreta desplegada");
    this.audio.place();
  }

  /** Per-frame: each deployed turret tracks + hitscans the nearest bot in range, then expires. */
  private turretFrame(dt: number): void {
    if (this.turrets.length === 0) return;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      if (this.time > t.until) { this.disposeTurret(t); this.turrets.splice(i, 1); continue; } // expired
      t.cd -= dt;
      let bid = -1, bd = 34 * 34, bx = 0, by = 0, bz = 0;
      for (const [id, p] of this.aiBots) { const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 < bd) { bd = d2; bid = id; bx = p.x; by = p.y; bz = p.z; } }
      if (bid < 0) { // IDLE: slow sweep + gentle pitch bob → a sentry "scanning" for new drones (never snaps to a heading)
        t.yaw += 0.7 * dt;
        t.pitch += (Math.sin(this.time * 0.8 + t.x) * 0.12 - t.pitch) * Math.min(1, dt * 2);
        t.head.rotation.set(t.pitch, t.yaw, 0);
        continue;
      }
      // TARGET: rotate the head TOWARD it at a capped rate (smooth — not the old instant lookAt snap)
      const ddx = bx - t.x, ddz = bz - t.z, horiz = Math.hypot(ddx, ddz) || 1e-3;
      const wantYaw = Math.atan2(ddx, ddz), wantPitch = -Math.atan2(by - t.y, horiz);
      const step = 4.0 * dt; // ~230°/s cap — tracks briskly but visibly turns, no teleport-aim
      let dy2 = wantYaw - t.yaw; dy2 -= Math.round(dy2 / (Math.PI * 2)) * Math.PI * 2; // shortest angle
      t.yaw += Math.abs(dy2) <= step ? dy2 : Math.sign(dy2) * step;
      const dp = wantPitch - t.pitch; t.pitch += Math.abs(dp) <= step ? dp : Math.sign(dp) * step;
      t.head.rotation.set(t.pitch, t.yaw, 0);
      if (t.cd <= 0 && Math.abs(dy2) < 0.4) { // fire once roughly on-aim (so it settles before shooting), then cool down
        t.cd = 0.8; // slow, deliberate cadence — the sentry is support, not a minigun
        const dx = bx - t.x, dy = by - t.y, dz = bz - t.z, l = Math.hypot(dx, dy, dz) || 1;
        this.hitBotAlongRay(t.x, t.y, t.z, dx / l, dy / l, dz / l, 36, 2); // host-auth damage; wall-checked inside
        this.flashAt(t.x, t.y + 0.2, t.z, 0.18);
        this.recordShot(t.x, t.z, dx / l, dz / l);
      }
    }
  }

  /** Free one sentry's scene node + per-turret geometries (turretMat / turretAccentMat are shared → left). */
  private disposeTurret(t: { mesh: THREE.Object3D }): void {
    this.renderer.scene.remove(t.mesh);
    t.mesh.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) me.geometry.dispose(); });
  }

  /** Tear down every deployed sentry — on the owner's death (they stop working when he falls), on a fresh match. */
  private clearTurrets(): void {
    for (const t of this.turrets) this.disposeTurret(t);
    this.turrets.length = 0;
  }

  /** Tests a shot ray (unit dir) against the co-op bots within `range` and damages the NEAREST — but ONLY if
   *  no wall sits between the shooter and that bot (grid raycast), so a bullet can't pass through a wall to
   *  hit a drone. Host applies the damage; a peer reports it. Returns whether a bot was hit. */
  private hitBotAlongRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, botDmg: number): boolean {
    if (this.mode !== "coop" || this.aiBots.size === 0) return false;
    let hitId = -1, hitT = range;
    for (const [id, p] of this.aiBots) {
      const wx = p.x - ox, wy = p.y - oy, wz = p.z - oz;
      const t = wx * dx + wy * dy + wz * dz;                 // projection of the bot onto the ray
      if (t < 0 || t > hitT) continue;
      const cx = ox + dx * t - p.x, cy = oy + dy * t - p.y, cz = oz + dz * t - p.z;
      if (cx * cx + cy * cy + cz * cz < 1.4) { hitId = id; hitT = t; } // within ~1.2 m of the line
    }
    if (hitId < 0) return false;
    const wall = this.grid.raycast(ox, oy, oz, dx, dy, dz, hitT); // a wall nearer than the bot blocks the shot
    if (wall && wallBlocks(hitT, wall.distance)) return false;
    const bp = this.aiBots.get(hitId)!;
    if (this.smokeBlocks(ox, oy, oz, bp.x, bp.y, bp.z)) return false; // …and you can't shoot a bot THROUGH smoke either
    if (this.hosting && this.swarm) { if (this.swarm.damageBot(hitId, botDmg, dx, dz)) this.onBotDead(hitId); } // pass the shot dir → tanks shield their front
    else if (this.net.connected) this.net.send({ t: "aihitbot", bot: hitId, dmg: botDmg });
    return true;
  }

  /** When the local player fires a BULLET weapon, test the aim ray against the bots (nearest, wall-checked). */
  private aiHitscan(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    const spec = WEAPONS[this.weapon];
    const range = botHitRange(spec, this.scopedNow, this.zoomLevel); // non-scoped reaches the tracer's travel; scoped hip-fire stays short
    if (this.hitBotAlongRay(ox, oy, oz, dx, dy, dz, range, spec.botDmg ?? 1)) { this.hud.hitMarker("hit"); this.audio.hitMarker(false); }
  }

  /** A bot died (host authority): mini explosion + falling wreckage, drop its avatar, credit the shooter. */
  private onBotDead(id: number): void {
    const p = this.aiBots.get(id);
    this.aiBots.delete(id);
    this.botBreakAt.delete(id); // keep the glass-break rate-limit map bounded to living bots
    this.remotes.remove(-id);
    this.myKills++;
    this.sessionKills++; // team total this session (host-authoritative → the co-op score)
    this.hud.hitMarker("kill");
    if (p) this.droneDeathFx(p.x, p.y, p.z);
    if (this.net.connected) this.net.send({ t: "aidead", bot: id, x: p ? +p.x.toFixed(1) : 0, y: p ? +p.y.toFixed(1) : 0, z: p ? +p.z.toFixed(1) : 0 });
  }

  /** Mini explosion (flash + sparks + smoke) and a burst of GPU debris that RAINS DOWN — reads as the drone
   *  blowing up and falling. Visual only (no terrain carve). Runs on every client via the `aidead` message. */
  private droneDeathFx(x: number, y: number, z: number): void {
    this.addFlash(x, y, z, 0.7);
    this.sink.burst(x, y, z, { count: 12, color: 0xffb867, speed: 8, size: 5, life: 0.35, buoyancy: 0, windCoupling: 0.2, kind: "spark", strength: 0.02 });
    this.sink.burst(x, y, z, { count: 8, color: 0x555a60, speed: 2.5, size: 11, life: 1.3, buoyancy: 1.6, windCoupling: 0.9, spread: 1.2, kind: "smoke", strength: 0.05 });
    this.sink.burst(x, y, z, { count: 0, color: 0, speed: 6, life: 6, kind: "debris", colorType: 0.73, strength: 0.28 }); // metal wreckage falls to the ground
    this.audio.death(false); // drone crash sound
  }

  // --- minimap -------------------------------------------------------------

  /** Records a shot ray (shooter origin + normalized fire direction) for the minimap; caps the list. */
  private recordShot(x: number, z: number, dx: number, dz: number): void {
    const h = Math.hypot(dx, dz) || 1;
    this.recentShots.push({ x, z, dx: dx / h, dz: dz / h, life: 1 });
    if (this.recentShots.length > 24) this.recentShots.shift();
  }

  /** Per-frame: draw the HEADING-UP minimap (self at centre + friend/enemy blips within radius + fading shot
   *  rays). Friend/enemy is by mode: co-op → drones are the enemy; PvP → the opposite role. */
  private minimapFrame(dt: number): void {
    const cp = this.player.camera.position, f = this.player.forward(this.tmpDir);
    const radar = this.remotes.radar();
    const blips = this._blips;
    while (blips.length > radar.length) blips.pop();
    while (blips.length < radar.length) blips.push({ x: 0, z: 0, enemy: false });
    for (let i = 0; i < radar.length; i++) {
      const e = radar[i], b = blips[i];
      // co-op: the enemy is the drone swarm; PvP: anyone not on our team (works for drone-vs-drone too)
      b.x = e.x; b.z = e.z; b.enemy = this.mode === "coop" ? !e.isHuman : e.team !== this.myTeam;
    }
    for (let i = this.recentShots.length - 1; i >= 0; i--) {
      this.recentShots[i].life -= dt / 1.5;
      if (this.recentShots[i].life <= 0) this.recentShots.splice(i, 1);
    }
    const heading = Math.atan2(f.x, f.z);
    // frontal-scanner pings: drop expired, feed the minimap overlay + directional HUD markers + status panel
    for (let i = this.scanPings.length - 1; i >= 0; i--) if (this.time >= this.scanPings[i].until) this.scanPings.splice(i, 1);
    this.hud.drawMinimap(cp.x, cp.z, heading, blips, this.recentShots, this.minimapBig, this.scanPings);
    const marks = this._scanMarks;
    while (marks.length > this.scanPings.length) marks.pop();
    while (marks.length < this.scanPings.length) marks.push({ angle: 0, behindWall: false });
    for (let i = 0; i < this.scanPings.length; i++) {
      const p = this.scanPings[i], m = marks[i];
      m.angle = bearing(heading, cp.x, cp.z, p.x, p.z); m.behindWall = p.behindWall;
    }
    this.hud.setScanMarkers(marks);
    if (this.mode === "free" || this.phase !== "playing") this.hud.setScanStatus("off");
    else if (this.time >= this.scanReadyAt) this.hud.setScanStatus("ready");
    else this.hud.setScanStatus("charging", 1 - (this.scanReadyAt - this.time) / Game.SCAN_CD);
  }

  /** R does double duty: if the current weapon can be RELOADED (mag not full and reserve left) it swaps a fresh
   *  magazine — a TACTICAL reload that WASTES whatever was still in the old mag ("tolva cambiada, balas perdidas").
   *  Otherwise (mag full, or nothing to load) it falls through to the frontal scanner. */
  private reloadOrScan(): void {
    if (this.mode === "free") { this.doScan(); return; }
    if (this.time < this.reloadingUntil) return; // busy reloading → R does nothing (no re-reload, no scan)
    const spec = WEAPONS[this.weapon], cur = this.ammo[this.weapon];
    if (cur.mag < spec.magSize && cur.reserve > 0) {
      const r = reloadMag(cur, spec.magSize);
      this.ammo[this.weapon] = r.ammo;
      this.reloadingUntil = this.time + reloadDuration(spec); // the swap takes TIME — firing locked meanwhile
      this.audio.place(); // mechanical mag-swap clunk (reuse the deploy sound)
      this.hud.setWeapon(this.role, this.weapon, r.ammo, classLoadout(this.role, this.myClass));
      this.hud.flash(r.lost > 0 ? `🔄 Recargando · ${r.lost} balas perdidas` : "🔄 Recargando…");
      return;
    }
    this.doScan(); // nothing to reload → the scanner instead
  }

  /** Frontal scanner (R): a recharging cone pulse that reveals enemy drones/soldiers ahead — even BEHIND walls —
   *  as fading minimap pings + on-screen directional markers. Personal/local (no broadcast → desync-safe). Both
   *  roles, combat modes only. */
  private doScan(): void {
    if (this.mode === "free") return;
    if (this.time < this.scanReadyAt) { this.audio.emptyClick(); this.hud.flash(`📡 Recarga ${Math.ceil(this.scanReadyAt - this.time)}s`); return; }
    this.scanReadyAt = this.time + Game.SCAN_CD;
    const eye = this.player.camera.position, f = this.player.forward(this.tmpDir);
    this.scanPings.length = 0;
    const add = (ex: number, ey: number, ez: number): void => {
      if (this.scanPings.length >= Game.SCAN_MAX) return;
      if (!inScanCone(eye.x, eye.z, f.x, f.z, ex, ez, Game.SCAN_RANGE, Game.SCAN_MINDOT)) return;
      const behindWall = !this.aiCanSee(eye.x, eye.y, eye.z, ex, ey + 1, ez); // through-wall detection → flag it (cosmetic)
      this.scanPings.push({ x: ex, y: ey, z: ez, until: this.time + Game.SCAN_LIFE, behindWall });
    };
    if (this.mode === "coop") { for (const p of this.aiBots.values()) add(p.x, p.y, p.z); } // enemy = the AI drone swarm
    else { this.remotes.enemyPositions(this.myTeam, this.mode === "vs", this.scanEnemyBuf); for (const p of this.scanEnemyBuf) add(p.x, p.y, p.z); }
    this.audio.scan(); // sonar ping/sweep
    const n = this.scanPings.length;
    this.hud.flash(n > 0 ? `📡 Escáner: ${n} contacto${n > 1 ? "s" : ""}` : "📡 Escáner: sin contactos");
  }

  private onNet(m: NetMsg): void {
    if (m.t === "hello") {
      // got our network id → spawn point is derived from it in spawnPlayerInBuilding (perimeter band)
      if (this.phase === "lobby") { this.broadcastLobby(); return; } // announce self; wait for the host to begin
      if (this.mode === "dvh" || this.mode === "vs" || this.mode === "coop") this.assignRoleAndController();
      this.spawnPlayerInBuilding();
      // We may have joined AFTER destruction happened. Our world is pristine (seed-built) → ask any peer
      // that already has destruction to send us its diff, so our grid matches theirs (fixes the desync
      // where a late joiner sees a building standing that everyone else already collapsed).
      this.net.send({ t: "needsync" });
    } else if (m.t === "join") {
      // A peer connected mid-match. If WE are the host and a match is live, replay `begin` DIRECTED at them
      // so they enter the running match instead of being stranded in the lobby; their beginMatch then fires
      // needsync → gridsync to reconcile our destruction. (Older relay peers already ignore an unknown `join`.)
      if (this.phase === "playing" && !this.matchOver && this.net.id === (hostOf(this.lobby) ?? this.net.id))
        this.net.send({ t: "begin", to: m.id, mode: this.mode, map: this.mapSize, hardcore: this.coopHardcore });
    } else if (m.t === "lobby") {
      if (this.phase !== "lobby") return;
      this.lobby = m.role ? applyPick(this.lobby, m.id as number, m.role as Role) : applyJoin(this.lobby, m.id as number);
      if (m.map && MAP_SIZES[m.map as MapSize]) this.pendingMapSize = m.map as MapSize; // joiner learns the room's map size
      if (m.mode && this.pendingMode !== m.mode) { // joiner learned the room's mode from the host
        this.pendingMode = m.mode as Mode;
        if (m.mode === "coop") this.myRole = "human"; // co-op: everyone's a soldier
        this.showLobbyUi();
      }
      this.refreshLobby();
    } else if (m.t === "begin") {
      // first start (from the lobby) OR a host-driven RESTART after the match ended — but never mid-fight.
      if (!beginAddressedToMe(m.to as number | undefined, this.net.id)) return; // a directed late-join begin is only for its target
      // begin always comes FROM the host (relay stamps m.id); a late joiner's roster is just itself, so record
      // the host here → hostOf() resolves to the real host, not the joiner (else the joiner could hijack a restart).
      if (typeof m.id === "number" && m.id !== this.net.id) this.lobby = applyJoin(this.lobby, m.id);
      if (canBeginMatch(this.phase, this.matchOver)) { if (m.mode) this.pendingMode = m.mode as Mode; if (m.map && MAP_SIZES[m.map as MapSize]) this.pendingMapSize = m.map as MapSize; this.coopHardcore = !!m.hardcore; this.beginMatch(); }
    } else if (m.t === "ai") {
      if (this.mode === "coop" && !this.hosting) { // peers render the host's swarm from its broadcast
        this.aiBots.clear();
        for (const row of m.b as number[][]) this.aiBots.set(row[0], { x: row[1], y: row[2], z: row[3] });
        this.sessionKills = (m.k as number) ?? this.sessionKills; // host-authoritative team score + wave
        this.hud.setCoopScore(this.sessionKills, (m.w as number) ?? 0);
      }
    } else if (m.t === "aifire") {
      this.muzzleFlash(new THREE.Vector3(m.x as number, m.y as number, m.z as number), new THREE.Vector3(m.dx as number, m.dy as number, m.dz as number), 0.3);
      this.recordShot(m.x as number, m.z as number, m.dx as number, m.dz as number); // minimap: a drone opened fire
    } else if (m.t === "aidrop") { // a bomber released a grenade → show the falling bomb (ghost; blast arrives via `explode`)
      this.projectiles.launchGrenade(new THREE.Vector3(m.x as number, (m.y as number) - 0.4, m.z as number), new THREE.Vector3(0, -1, 0), 1.5, true, 1, true);
    } else if (m.t === "smoke") { // a soldier deployed a smoke cloud → everyone shares it (LOS block + FX)
      this.addSmoke(m.x as number, m.y as number, m.z as number);
    } else if (m.t === "aihit") {
      if ((m.to as number) === this.net.id && this.hp > 0) this.damageDrone(m.dmg as number, m.x as number, m.z as number); // host said a bot hit me
    } else if (m.t === "aihitbot") {
      if (this.hosting && this.swarm && this.swarm.damageBot(m.bot as number, (m.dmg as number) || 1)) this.onBotDead(m.bot as number); // a peer shot a bot (dmg: sniper=3, else 1)
    } else if (m.t === "aistun") {
      if (this.hosting && this.swarm) this.swarm.stunBots(m.x as number, m.z as number, (m.r as number) || 9, (m.dur as number) || 3.2); // a peer's EMP → host disables the drones in radius
    } else if (m.t === "aidead") {
      this.aiBots.delete(m.bot as number); this.remotes.remove(-(m.bot as number));
      if (typeof m.x === "number") this.droneDeathFx(m.x as number, m.y as number, m.z as number); // peers see the blast + fall
    } else if (m.t === "aiboom") { // a kamikaze detonated → drop its avatar + crash FX (blast arrives via `explode`)
      this.aiBots.delete(m.bot as number); this.remotes.remove(-(m.bot as number));
      this.droneDeathFx(m.x as number, m.y as number, m.z as number);
    } else if (m.t === "coopover") {
      this.matchOver = true; this.hud.hideDeath(); this.hud.showGameOver(m.k as number, m.w as number); this.releaseCursor(); // host declared team-wipe
    } else if (m.t === "needsync") {
      // a peer joined and asked for the world's destruction. If we have any, send our compact diff
      // (only real gameplay destruction, not window/door cuts) addressed to that joiner.
      if (this.grid.removedSinceGen.size > 0 && (m.id as number) !== this.net.id) {
        this.net.send({ t: "gridsync", to: m.id, keys: [...this.grid.removedSinceGen] });
      }
    } else if (m.t === "gridsync") {
      // we're the joiner: replay the room's destruction on top of our pristine world so the grids match.
      // Exactly one snapshot per world (first peer to answer wins) — later duplicates are ignored.
      if ((m.to as number) === this.net.id && !this.syncedFromPeer) {
        this.syncedFromPeer = true;
        for (const k of m.keys as number[]) { const [x, y, z] = unpackKey(k); this.grid.remove(x, y, z); }
        this.markAllDirty();        // rebuild every mesh/collider chunk to match the reconciled grid
        this.structureDirty = true; // settle anything the diff leaves unsupported (already-settled → no-op)
      }
    } else if (m.t === "state") {
      this.remotes.upsert(m.id as number, m.x as number, m.y as number, m.z as number,
        m.qx as number, m.qy as number, m.qz as number, m.qw as number, m.hp as number, (m.role as Role) ?? "drone", (m.mhp as number) || MAX_HP,
        (m.ry as number) || 0, (m.rp as number) || 0, ((m.st as number) || 0) as 0 | 1 | 2,
        (m.tm as number) || 0, (m.cls as string) || "");
      if (this.mode === "dvh" && typeof m.dk === "number") {
        const merged = reconcileKills({ drone: this.droneKills, human: this.humanKills }, { drone: m.dk as number, human: m.hk as number });
        this.droneKills = merged.drone; this.humanKills = merged.human;
        this.checkMatchWin();
      }
    } else if (m.t === "weapon") {
      this.fireRemoteWeapon(m);
      this.recordShot(m.ox as number, m.oz as number, m.dx as number, m.dz as number); // minimap: a peer opened fire
    } else if (m.t === "explode") {
      this.explodeAt(m.x as number, m.y as number, m.z as number, m.r as number, m.p as number, false, m.id as number, true, m.tm as number | undefined);
    } else if (m.t === "medkit") {
      this.medkits.take(m.i as number, this.time); // a peer grabbed a medkit → hide it here too
    } else if (m.t === "ammo") {
      this.ammoCrates.take(m.i as number, this.time); // a peer grabbed a crate → hide it here too
    } else if (m.t === "hit") {
      this.applyBulletHit(
        m.vx as number, m.vy as number, m.vz as number, m.dx as number, m.dy as number, m.dz as number,
        m.px as number, m.py as number, m.pz as number, m.nx as number, m.ny as number, m.nz as number,
      );
    } else if (m.t === "died") {
      if (this.mode === "dvh" && m.scored !== false) this.addKill(m.role as Role); // a peer died to an enemy → their team scores (PvP only; missing field = older peer → old behavior)
      const by = m.by as number, mine = by === this.net.id;
      const victim = (m.role as Role) === "human" ? "🧍" : "🤖";
      const killer = mine ? "Tú" : by ? `J${by % 1000}` : ""; // no name layer → short id label
      this.hud.killfeed(killer ? `${killer} ☠ ${victim}` : `${victim} caído`, mine);
      if (mine) { this.myKills++; this.hud.flash("¡Derribo!"); this.hud.hitMarker("kill"); this.audio.hitMarker(true); }
      else if (Array.isArray(m.assist) && (m.assist as number[]).includes(this.net.id)) this.myAssists++;
    } else if (m.t === "melee") {
      this.remotes.meleeAnim(m.id as number); // swing on the attacker's avatar
      const p = this.player.camera.position;
      if (this.hp > 0 && !this.friendlyFire(m.tm) && meleeHit(m.ox as number, m.oy as number, m.oz as number, m.dx as number, m.dy as number, m.dz as number, p.x, p.y, p.z, m.range as number, 0.5)) {
        this.recordDamager(m.id as number); this.damageDrone(m.dmg as number, m.ox as number, m.oz as number); this.audio.meleeHit();
      }
    } else if (m.t === "leave") {
      if (this.phase === "lobby") { this.lobby = applyLeave(this.lobby, m.id as number); this.refreshLobby(); }
      this.remotes.remove(m.id as number);
    }
  }

  /** DvH: derive our team from the network id (assignRole applied in id order → balanced, stable,
   *  identical on every client) and swap the local controller to a Walker if we're a human. */
  private assignRoleAndController(): void {
    // Headless/non-lobby path: co-op → everyone's a soldier; PvP → auto-balance by id. The LOBBY path calls
    // applyChosenRole directly with the role the player picked.
    const r: Role = this.mode === "coop" ? "human" : assignRole([], this.net.id);
    this.myTeam = this.mode === "coop" ? 0 : this.mode === "dvh" ? teamForRole(r) : this.autoTeam();
    this.applyChosenRole(r);
  }

  /** Applies a role + class: swaps the local controller (Walker human / flying drone Player), then sets
   *  the class HP / primary weapon / movement multipliers / camera. Class defaults to the current pick. */
  private applyChosenRole(role: Role, cls: UnitClass = this.myClass): void {
    this.role = role;
    this.myClass = cls;
    const wantWalker = role === "human";
    if (wantWalker !== (this.player instanceof Walker)) {
      this.player.dispose();
      this.player = wantWalker ? new Walker(this.physics, this.grid, PLAY_BOUNDS) : new Player(this.physics);
    }
    this.hp = this.myMaxHp(); // per-class max (heavy tank … scout fragile)
    this.weapon = classLoadout(this.role, this.myClass)[0]; // start on the class primary
    this.bloom = 0; // fresh weapon → no inherited spread bloom
    this.reloadingUntil = 0; // class swap never inherits a reload lock
    this.viewmodel.setWeapon(this.weapon, this.role, this.myClass); // hold the class primary (soldiers only; drone → nothing)
    const mv = classMove(this.role, this.myClass);
    this.player.setClassMods(mv.speedMul, mv.jumpMul); // scout runs, heavy lumbers, interceptor screams
    this.resupply();
    this.camFx.setRole(this.role); // FPV for drones, body-cam for humans
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
    // class badge (PvP only): show the chosen class + team; hidden in co-op/sandbox
    this.hud.setClass(this.mode === "dvh" ? classStats(this.role, this.myClass).label : "", TEAM_LABEL[this.myTeam]);
  }

  /** Local max HP: per-class in any versus/co-op mode (heavy tank … scout fragile), else the default. */
  private myMaxHp(): number { return this.mode === "dvh" || this.mode === "vs" || this.mode === "coop" ? classMaxHp(this.role, this.myClass) : MAX_HP; }

  /** PvP friendly-fire gate: in dvh, a shot/blast/melee tagged with OUR team does no damage to us. Co-op
   *  and the sandbox keep friendly fire ON — and AI blasts (which carry no real player team) are never
   *  gated, since they only occur in co-op. An untagged message (older peer) is treated as an enemy hit. */
  private friendlyFire(srcTeam: unknown): boolean {
    return this.mode === "dvh" && typeof srcTeam === "number" && srcTeam === this.myTeam;
  }

  /** Scores a kill for the team opposing the victim, then checks for a match win. */
  private addKill(victim: Role): void {
    if (victim === "human") this.droneKills++; else this.humanKills++;
    this.checkMatchWin();
  }

  /** DvH win check: destroy the enemy objective or hit the kill limit. Objectives live in the
   *  synced grid, so every client reaches the same verdict. */
  private readonly objMatAt = (x: number, y: number, z: number): MaterialId | undefined => this.grid.get(x, y, z); // hoisted: checkMatchWin runs per frame
  private checkMatchWin(): void {
    if (this.mode !== "dvh" || this.matchOver) return;
    const hasObjectives = OBJECTIVE_SITES.length >= 4; // micro/small presets place no bases → kill-limit-only match
    let droneObjsAlive = 2, humanObjsAlive = 2, droneHp = 1, humanHp = 1; // objectiveless defaults: full bases (HUD 🟢🟢), never an objective win
    if (hasObjectives) {
      const mat = this.objMatAt;
      // count each team's SURVIVING bases (destroyed = ~75% of its metal razed) + weakest-base HP for the HUD
      droneObjsAlive = 0; humanObjsAlive = 0;
      for (const s of OBJECTIVE_SITES) {
        const hp = objectiveHp(s, mat); // one site scan; hp >= 0.25 ⟺ !objectiveDestroyed (prefabs.ts)
        if (s.team === "drone") { if (hp >= 0.25) droneObjsAlive++; droneHp = Math.min(droneHp, hp); }
        else { if (hp >= 0.25) humanObjsAlive++; humanHp = Math.min(humanHp, hp); }
      }
    }
    this.hud.setScore(this.droneKills, this.humanKills, droneObjsAlive, humanObjsAlive, droneHp, humanHp);
    if (hasObjectives) {
      // Alert MY team when OUR base crosses a damage threshold, so teams rotate to defend instead of
      // losing a base unnoticed. Pure crossing detection → every client alerts on the same synced HP.
      const myHp = this.role === "drone" ? droneHp : humanHp;
      const myPrev = this.role === "drone" ? this.prevDroneHp : this.prevHumanHp;
      const alert = baseAlert(myPrev, myHp);
      if (alert !== null) {
        this.hud.flash(alert === 0 ? "🛑 ¡Base destruida!" : `⚠ ¡Base bajo ataque! ${Math.round(alert * 100)}%`);
        this.audio.baseAlarm();
      }
      this.prevDroneHp = droneHp; this.prevHumanHp = humanHp;
    }
    const state: MatchState = hasObjectives
      ? { droneObjsAlive, humanObjsAlive, droneKills: this.droneKills, humanKills: this.humanKills }
      : killLimitOnlyState(this.droneKills, this.humanKills);
    const winner = checkWin(state, Game.KILL_LIMIT);
    if (winner) { this.matchOver = true; this.hud.showWin(winner, this.role); this.releaseCursor(); }
  }

  /** Spawns a GHOST of a weapon a remote player fired — it flies for the visuals but never mutates
   *  the grid; the authoritative `explode`/`hit` message from that player does the actual damage. */
  private fireRemoteWeapon(m: NetMsg): void {
    const o = new THREE.Vector3(m.ox as number, m.oy as number, m.oz as number);
    const d = new THREE.Vector3(m.dx as number, m.dy as number, m.dz as number);
    if (m.k === "bullet") {
      this.projectiles.launchBullet(o, d, WEAPONS[m.w as Weapon]?.bulletSpeed ?? 120, true); // sniper tracer is faster
      this.muzzleFlash(o, d, 0.34); // enemy gunfire is visible/spottable at range
      const base = (m.dmg as number) || 0; // a bullet in our line of fire hurts us — unless it's a teammate's (PvP)
      if (base > 0 && this.hp > 0 && !this.friendlyFire(m.tm) && this.bulletHitsMe(o, d)) {
        const p = this.player.camera.position;
        const dmg = base * bulletFalloff((m.w as string) || "", Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z));
        this.recordDamager(m.id as number); this.damageDrone(Math.round(dmg), o.x, o.z); // range-scaled (shotgun close = lethal, far = weak)
      }
    } else if (m.k === "grenade") this.projectiles.launchGrenade(o, d, 22, true);
    else if (m.k === "missile") this.projectiles.launchRocket(o, d, 52, true);
  }

  private readonly enemyBuf: { x: number; y: number; z: number }[] = [];

  /** Predicts whether OUR shot's line of fire strikes an enemy peer (before a wall stops it) and, if so,
   *  fires a hit marker + tick locally. Damage stays authoritative on the victim; this is display-only, so
   *  a rare disagreement self-corrects on the next state tick. */
  private predictHit(o: THREE.Vector3, d: THREE.Vector3): void {
    if (!this.net.connected) return;
    this.remotes.enemyPositions(this.myTeam, this.mode === "free" || this.mode === "coop", this.enemyBuf);
    if (this.enemyBuf.length === 0) return;
    const wall = this.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 220);
    const maxD = wall ? wall.distance : 220;
    for (const p of this.enemyBuf) {
      if (rayHitsSphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y, p.z, maxD, 1.0)) {
        this.hud.hitMarker("hit"); this.audio.hitMarker(false); return;
      }
    }
  }

  /** Does an incoming shot's line of fire strike our own player, before a wall stops the bullet? */
  private bulletHitsMe(o: THREE.Vector3, d: THREE.Vector3): boolean {
    const hit = this.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 220);
    const wall = hit ? hit.distance : 220;
    const p = this.player.camera.position;
    return rayHitsSphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y, p.z, wall, 1.0);
  }

  /** Connects with an explicit mode/room (used by the automated multiplayer test). */
  debugJoin(mode: Mode, room: string): void {
    this.mode = mode;
    this.hp = this.myMaxHp();
    this.rebuildWorld(hashStr(room), mode === "free");
    this.net.connect(room);
  }
  debugRemoteCount(): number { return this.remotes.count; }
  debugRemotePos(): { x: number; y: number; z: number } | null { return this.remotes.firstPos(); }
  debugHp(): number { return this.hp; }
  debugObjectives(): typeof OBJECTIVE_SITES { return OBJECTIVE_SITES; }
  debugNetConnected(): boolean { return this.net.connected; }
  debugNetSent(): number { return this.netSent; }
  debugExplodeNet(x: number, y: number, z: number, r = 3.4, p = 520): void { this.explodeAt(x, y, z, r, p, true); }
  debugSettle(): void { for (let i = 0; i < 400 && this.structureDirty; i++) this.collapseStep(); }

  /** Per-frame networking: broadcast our drone state, drop stale peers, handle respawn. */
  private netUpdate(dt: number): void {
    this.remotes.prune();
    { const cp = this.player.camera.position; this.remotes.update(dt, cp.x, cp.z); } // ease peers + LOD distant skins
    // respawn works in every mode, even offline (blasts/debris can kill you in the sandbox too) — but never
    // once the match/session is over (dvh win or co-op team-wipe), and never past an infinite respawn (permadeath)
    if (this.hp <= 0 && this.time >= this.respawnAt && !this.matchOver) {
      this.hp = this.myMaxHp();
      this.spawnPlayerInBuilding();
      this.resupply(); // full ammo + battery on respawn
      this.audio.respawn();
      this.hud.setHealth(this.hp, this.myMaxHp(), true);
    }
    if (!this.net.connected) return;
    this.netT -= dt;
    if (this.netT > 0) return;
    this.netT = 0.05; // ~20 Hz
    this.netSent++;
    const p = this.player.camera.position, q = this.player.camera.quaternion;
    this.lastState = {
      t: "state",
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      qx: +q.x.toFixed(3), qy: +q.y.toFixed(3), qz: +q.z.toFixed(3), qw: +q.w.toFixed(3),
      ry: +this.player.lookYaw.toFixed(3), rp: +this.player.lookPitch.toFixed(3), st: this.player.stanceVal,
      hp: this.hp, mhp: this.myMaxHp(), role: this.role, // role → avatar; mhp → correct health bar
      tm: this.myTeam, cls: this.myClass, // team → friend/enemy + FF; class → avatar tint/label
      dk: this.droneKills, hk: this.humanKills, // scoreboard → max-merged by peers (self-healing)
    };
    this.net.send(this.lastState);
  }

  /** Applies damage to our own drone (blasts + fast debris, in every mode) — computed locally on
   *  each client and broadcast via the periodic state message, so health stays consistent. */
  private damageDrone(amount: number, srcX?: number, srcZ?: number): void {
    if (this.hp <= 0) return;
    // the heavy soldier carries an armored riot shield → 40% damage reduction (combat modes only)
    const shielded = this.role === "human" && this.myClass === "heavy" && (this.mode === "dvh" || this.mode === "vs" || this.mode === "coop");
    const dmg = shielded ? amount * 0.6 : amount;
    this.bandageT = 0; // taking a hit interrupts an in-progress bandage (no partial heal)
    this.hp = Math.max(0, this.hp - dmg);
    this.trauma = addTrauma(this.trauma, Math.min(0.6, dmg / 60)); // taking a hit jolts the view + flashes the HUD
    this.hud.damageFlash(Math.min(1, dmg / 50));
    if (srcX !== undefined && srcZ !== undefined) { // point an on-screen arc at where the hit came from
      const cp = this.player.camera.position, f = this.player.forward(this.tmpDir);
      this.hud.damageArrow(bearing(Math.atan2(f.x, f.z), cp.x, cp.z, srcX, srcZ), Math.min(1, dmg / 40));
    }
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
    if (this.hp > 0) this.audio.hit(); else this.audio.death(this.role === "human"); // drones crash, not grunt
    if (this.hp <= 0) {
      this.myDeaths++;
      this.clearTurrets(); // the engineer fell → his sentries go dark (they run on his uplink)
      if (this.mode === "coop") {
        // Co-op survival: permadeath, or if you were the LAST soldier standing → no respawn (team-wipe ends it).
        // Otherwise wait a growing countdown (10 s + 5 s per prior death) while a teammate keeps the run alive.
        const teammateAlive = this.remotes.peers().some((p) => p.isHuman && p.hp > 0);
        if (this.coopHardcore || !teammateAlive) {
          this.respawnAt = Infinity;
          this.hud.flash(this.coopHardcore ? "☠ Eliminado (permadeath)" : "☠ Derribado…");
        } else {
          const d = respawnDelay(this.myDeaths);
          this.respawnAt = this.time + d;
          this.hud.flash(`Derribado — reapareces en ${d}s`);
        }
      } else {
        this.respawnAt = this.time + 3;
        this.hud.flash("Derribado — reapareces en 3s");
      }
      if (this.mode !== "free") {
        // Attribute the kill: the most-recent damager (last ~6 s) is the killer; earlier ones assist.
        let killer = 0, killerT = -1; const assist: number[] = [];
        for (const [id, t] of this.damagers) {
          if (this.time - t > 6) continue;
          if (t > killerT) { if (killer) assist.push(killer); killer = id; killerT = t; } else assist.push(id);
        }
        this.damagers.clear();
        const scored = deathScores(killer, assist.length); // environmental/suicide deaths don't score for the enemy
        this.net.send({ t: "died", role: this.role, by: killer, assist, scored }); // peers score + credit the killer
        if (this.mode === "dvh" && scored) this.addKill(this.role);         // team score (relay doesn't echo)
      }
    }
  }

  /** Records a peer as having just damaged us, for kill/assist attribution when we die. */
  private recordDamager(by: number): void { if (by) this.damagers.set(by, this.time); }

  /**
   * Picks a safe GPU-particle buffer size. A detonation chain can light up almost the
   * whole buffer in one frame, so on software/limited GPUs an oversized buffer spikes
   * the driver into a timeout (the "shoot → whole machine freezes" crash). Power users
   * can still force a larger buffer with ?ptex=1024.
   */
  private pickParticleTexSize(): number {
    const override = Number(new URLSearchParams(location.search).get("ptex"));
    if (override > 0) return Math.max(128, Math.min(1024, Math.floor(override)));
    const gl = this.renderer.renderer.getContext();
    const name = this.gpuName().toLowerCase();
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (/swiftshader|llvmpipe|software|microsoft basic|mesa/.test(name) || maxTex < 8192) return 128;
    return 256;
  }

  /** The GL renderer string (e.g. "AMD … GCN-5"), or "" if the extension is blocked for privacy. */
  private gpuName(): string {
    try {
      const gl = this.renderer.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) return String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    } catch { /* extension unavailable (privacy) */ }
    return "";
  }

  /** Applies the current preset across every subsystem it drives (renderer, mortar detail, audio). One
   *  place so shadows/pixels/detail/audio can never drift apart. voxelDetail follows the preset here
   *  (the baseline); the auto-scaler can still drop detail INDEPENDENTLY below that to hold 60 fps. */
  private applyQualityPreset(): void {
    const cfg = qualityConfig(this.quality, window.devicePixelRatio || 1);
    this.renderer.applyQuality(cfg);
    this.voxelDetailOn = cfg.voxelDetail;
    this.mesher.setVoxelDetail(this.voxelDetailOn);
    this.audio.setLowAudio(this.quality === "bajo"); // drop the reverb convolver on the lightest preset
  }

  /** Sets the graphics-quality preset live (menu or K), applies it across subsystems, and persists. */
  private setQuality(q: Quality): void {
    this.quality = q;
    this.settings.quality = q;
    saveSettings(this.settings); // syncs both "visualSettings" and the legacy "quality" key (renderer AA)
    this.applyQualityPreset();
    this.interiorLights?.build(placedBuildings(), this.interiorLightBudget()); // re-scale interior lights to the preset
    this.hud.flash(`Calidad: ${q.toUpperCase()}${q === "bajo" ? " · recargá para quitar el suavizado" : ""}`);
  }

  /** Cycles Bajo → Medio → Alto (the K key). */
  private cycleQuality(): void {
    this.setQuality(QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.quality) + 1) % QUALITY_ORDER.length]);
  }

  /** Sets the live view-bubble radius (settings menu) and persists it. */
  private setViewDist(d: number): void {
    this.renderDist = clampViewDist(d);
    this.renderer.setViewDistance(this.renderDist);
    this.settings.viewDist = this.renderDist;
    saveSettings(this.settings);
  }

  /** Auto resolution ON → the dynamic-res controller + quality ladder manage performance (hold 60 fps). OFF →
   *  the player fixes resolution + quality; neither auto-system touches them. Freezes res at the current scale. */
  private setResAuto(on: boolean): void {
    this.settings.resAuto = on;
    if (!on) { this.settings.resScale = this.resScale; this.renderer.setRenderScale(this.resScale); }
    saveSettings(this.settings);
  }

  /** Manual resolution (menu slider): turns Auto OFF and fixes the render scale at `s`. */
  private setResScale(s: number): void {
    this.settings.resAuto = false;
    this.resScale = clampResScale(s);
    this.settings.resScale = this.resScale;
    this.renderer.setRenderScale(this.resScale);
    saveSettings(this.settings);
  }

  /** The "Automático" button: detect the safe preset from the GPU, hand resolution + quality back to the live
   *  auto-systems (Auto), reset the view distance to default — then dynamic-res + the ladder fine-tune in play. */
  private autoDetect(): VisualSettings {
    this.settings = autoSettings(this.gpuName());
    this.quality = this.settings.quality;
    this.renderDist = this.settings.viewDist;
    this.resScale = 1;
    saveSettings(this.settings);
    this.applyQualityPreset();
    this.interiorLights?.build(placedBuildings(), this.interiorLightBudget());
    this.renderer.setViewDistance(this.renderDist);
    this.renderer.setRenderScale(1);
    this.hud.flash(`Automático: ${this.quality.toUpperCase()} · resolución auto · vista ${this.renderDist}m`);
    return this.settings;
  }

  /** Opens the visual-settings panel (O key or gear). Releases the pointer lock so the cursor drives the UI. */
  private openSettings(): void {
    this.releaseCursor();
    this.hud.showSettings(this.settings, {
      setQuality: (q) => this.setQuality(q),
      setResAuto: (b) => this.setResAuto(b),
      setResScale: (s) => this.setResScale(s),
      setViewDist: (d) => this.setViewDist(d),
      auto: () => this.autoDetect(),
    });
  }

  /** Defends the 60fps floor when the frame rate stays low for a sustained window. Pulls ONE lever at a
   *  time, cheapest-visual-first (dynamic-res → mortar detail → preset), so a weak machine keeps playing
   *  at 60 without manual tuning and gives up the least visual it has to. One-way (bump back with K). */
  private adaptiveQuality(dt: number): void {
    // Only the "Auto" performance mode adapts the preset. If the player has taken manual resolution control,
    // they own quality too — never auto-drop their chosen preset.
    if (!this.settings.resAuto) { this.lowFpsSec = 0; return; }
    // Accumulate sustained-low time only while a lever remains (not yet fully floored at bajo + no detail).
    const flooredOut = this.quality === "bajo" && !this.voxelDetailOn;
    // TRANSIENT destruction lag (the collapse solve, debris physics, a particle burst) must NOT trip the
    // preset auto-downgrade: that permanently drops the user's visuals AND swaps materials, which forces
    // three.js to RECOMPILE every shader — a ~1 s freeze — for a spike that passes in a second (measured
    // in perf.log: a preset swap mid-collapse = a 1229 ms render frame). So only sustained low fps in a
    // QUIET scene accumulates; the recompile-free resolution lever (dynamic-res, every 0.4 s) still
    // defends the frame during destruction. Decays fast so a brief quiet dip doesn't creep toward a drop.
    const busy = this.structureDirty || this.debris.count > 0 || this.pendingFall.length > 0;
    if (this.fps < LOW_FPS && !flooredOut && !busy) this.lowFpsSec += dt;
    else this.lowFpsSec = Math.max(0, this.lowFpsSec - dt * 2);

    const lever = nextPerfLever({
      fps: this.fps,
      sustainedLowSec: this.lowFpsSec,
      resAtFloor: this.resScale <= RES_MIN + 0.001, // dynamic-res already floored → can't save more pixels
      detailOn: this.voxelDetailOn,
      quality: this.quality,
    });
    if (lever === "dropDetail") {
      // Cheapest visual to lose: the per-voxel mortar seams (~4ms). Below the preset baseline, live.
      this.voxelDetailOn = false;
      this.mesher.setVoxelDetail(false);
      this.lowFpsSec = 0;
      this.hud.flash("Detalle de superficie → OFF (auto, por rendimiento)");
    } else if (lever === "dropPreset") {
      const lower = lowerQuality(this.quality);
      if (!lower) return;
      // Session-only: do NOT persist the auto-downgrade, so one bad session can't silently ratchet down
      // the user's saved preference — their manual K choice is what persists. On reload it re-evaluates.
      this.quality = lower;
      this.applyQualityPreset();
      this.interiorLights?.build(placedBuildings(), this.interiorLightBudget());
      this.lowFpsSec = 0;
      const aa = lower === "bajo" ? " · recargá para quitar el suavizado" : "";
      this.hud.flash(`Calidad → ${lower.toUpperCase()} (auto, por rendimiento)${aa}`);
    }
    // "shrinkRes" / "none" → nothing to do here; the dynamic-res controller (every 0.4s) owns resolution.
  }

  /** Interior-light budget by graphics preset (bajo → none, so weak GPUs aren't taxed by extra lights). */
  private interiorLightBudget(): number { return this.quality === "bajo" ? 0 : this.quality === "medio" ? 2 : 8; }

  /** Creates the flashlight ONCE at intensity 0 (like the flash pool) so toggling it never changes the
   *  scene's light count → no one-time material recompile hitch. */
  private ensureFlashlight(): void {
    if (this.flashlight) return;
    const s = new THREE.SpotLight(0xfff2d0, 0, 48, 0.42, 0.35, 1.2); // warm cone, no shadow (perf)
    s.castShadow = false;
    this.renderer.scene.add(s, s.target);
    this.flashlight = s;
  }

  /** Toggles a head-mounted flashlight (drone or human). */
  private toggleFlashlight(): void {
    this.ensureFlashlight();
    this.flashOn = !this.flashOn;
    this.flashlight!.intensity = this.flashOn ? 9 : 0;
    this.audio.ui();
    this.hud.flash(this.flashOn ? "🔦 Linterna encendida" : "Linterna apagada");
  }

  /** Keeps the flashlight glued to the camera, pointing where the player looks. */
  private updateFlashlight(): void {
    const s = this.flashlight;
    if (!s || !this.flashOn) return;
    const cam = this.player.camera, dir = this.player.forward(this.tmpDir);
    s.position.copy(cam.position);
    s.target.position.set(cam.position.x + dir.x * 10, cam.position.y + dir.y * 10, cam.position.z + dir.z * 10);
    s.target.updateMatrixWorld();
  }

  /** Per-frame audio: the drone's rotor hum tracks its speed; a human plays footstep/jump/land events. */
  private audioFrame(): void {
    if (this.player instanceof Player) {
      // your OWN drone: you're inside it → centred + bright, tracks your throttle
      this.audio.setRotor(this.mode === "free" || this.hp > 0 ? 1 : 0, this.player.speed(), 0.032, 0, 4200);
    } else {
      const w = this.player;
      const p = w.camera.position;
      // a human HEARS enemy drones spatially: near = LOUD + BRIGHT + revved, far = a quiet MUFFLED hum, and it's
      // PANNED to whichever side the nearest drone is on (relative to where you're looking). AUD tighter → no
      // faraway droning.
      const n = this.remotes.nearestDrone(p.x, p.y, p.z);
      const AUD = 55;          // audible radius (m) — hear the swarm from farther
      const ROTOR_VOL = 0.32;  // LOUDER drone whir, still fully positional (level by distance, pan by bearing)
      if (n) {
        const f = w.forward(this.tmpDir);
        const brg = bearing(Math.atan2(f.x, f.z), p.x, p.z, n.x, n.z); // where the drone is vs your facing
        this.audio.setRotor(rotorLevel(n.dist, AUD), rotorPitch(n.dist, AUD), ROTOR_VOL, rotorPan(brg), rotorCutoff(n.dist, AUD) * frontBrightness(brg));
      } else this.audio.setRotor(0, 16, ROTOR_VOL);
      if (w.audioStep) { this.audio.footstep(w.audioRun); w.audioStep = false; }
      if (w.audioJump) { this.audio.jump(); w.audioJump = false; }
      if (w.audioLand) { this.audio.land(); w.audioLand = false; }
    }
  }

  /** True when the tab is hidden/blurred (its rAF loop is paused by the browser). */
  private hidden(): boolean { return typeof document !== "undefined" && document.hidden; }

  start(): void {
    // GameAudio's live AudioContext (constructed as a field) keeps the tab awake, resumed on the first
    // gesture. rAF drives the loop at display rate while the tab is VISIBLE (smooth, vsync'd).
    this.renderer.renderer.setAnimationLoop(() => { if (!this.hidden()) this.frame(); });
    // rAF is PAUSED by the browser on a hidden/blurred tab, which would FREEZE the whole game (physics,
    // networking, everything). A Web Worker timer is NOT visibility-throttled, so it keeps driving the
    // loop while hidden — the game keeps running (and syncing) even when the window loses focus.
    try {
      const tick = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),16)"], { type: "text/javascript" })));
      tick.onmessage = () => { if (this.hidden()) this.frame(); };
    } catch { /* no Worker → the game pauses when hidden, as a plain rAF app would */ }
    // Heartbeat fallback: re-emit the last state ~1 Hz so peers keep us even if the worker is unavailable.
    // In the lobby, re-announce our roster row instead, so late joiners converge on the full player list.
    setInterval(() => {
      if (!this.net.connected) return;
      if (this.phase === "lobby") this.broadcastLobby();
      else if (this.lastState) this.net.send(this.lastState);
    }, 1000);
  }

  /** Headless/debug helpers — used by the smoke test (no pointer-lock available there). */
  debugBlast(x: number, y: number, z: number, radius = 2.2, power = 360): void {
    this.explodeAt(x, y, z, radius, power);
    for (let i = 0; i < 400 && this.structureDirty; i++) this.collapseStep(); // fully settle (headless)
  }

  /** Fires n explosions across the building in a single tick — the worst case for "many
   *  simultaneous explosions"; the next frame coalesces them into ONE support solve. */
  debugBurst(n: number): void {
    for (let i = 0; i < n; i++) {
      const x = (6 + Math.random() * (BIG.W - 12)) * VOXEL;
      const z = (6 + Math.random() * (BIG.D - 12)) * VOXEL;
      const y = (3 + Math.random() * 34) * VOXEL;
      this.explodeAt(x, y, z, 2.2, 360);
    }
  }

  debugVoxelCount(): number {
    return this.grid.size;
  }

  /** Returns the per-component frame timing peaks/totals since the last call, then resets. */
  debugFrameProf(): typeof this.prof {
    const p = { ...this.prof };
    this.prof = this.profZero();
    return p;
  }

  /** Throws a grenade from the camera, exactly like the in-game grenade tool (for perf tests). */
  debugLaunchGrenade(): void {
    const dir = this.player.forward(new THREE.Vector3());
    this.projectiles.launchGrenade(this.player.camera.position.clone(), dir);
  }

  /** Fires a missile from the camera (for tests). */
  debugLaunchRocket(): void {
    const dir = this.player.forward(new THREE.Vector3());
    this.projectiles.launchRocket(this.player.camera.position.clone(), dir);
  }

  /** Fires a missile in an explicit direction (for tests, e.g. down at the floor). */
  debugLaunchRocketAim(dx: number, dy: number, dz: number): void {
    this.projectiles.launchRocket(this.player.camera.position.clone(), new THREE.Vector3(dx, dy, dz).normalize());
  }

  debugRocketCount(): number {
    return this.projectiles.rocketCount;
  }

  /** Voxels the coarse cell-support model considers unsupported right now (0 when intact). */
  debugUnsupportedCount(): number {
    let n = 0;
    for (const ck of this.grid.fallenCells(CELL_OVERHANG, CELL_MIN_MASS)) n += this.grid.cellVoxelKeys(ck).length;
    return n;
  }

  debugPhysicsStats(): { bodies: number; dynamic: number; colliders: number; debris: number; chunks: number } {
    let bodies = 0, dyn = 0;
    this.physics.world.forEachRigidBody((b) => { bodies++; if (b.isDynamic()) dyn++; });
    return { bodies, dynamic: dyn, colliders: this.physics.world.colliders.len(), debris: this.debris.count, chunks: 0 };
  }

  debugTimePhysics(n: number): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.physics.step(this.time + i * 0.016);
    return (performance.now() - t0) / n;
  }

  debugParticleMode(): string {
    return this.gpu ? `gpu:${this.gpu.capacity}` : "cpu";
  }

  /** Advances physics + rigid debris n fixed steps (headless has no animation loop). */
  debugStep(n: number): void {
    for (let i = 0; i < n; i++) {
      this.physics.step(this.time);
      this.time += FIXED_DT;
      this.debris.update(FIXED_DT);
      this.rebuildDirty();
    }
  }

  debugChunkCount(): number {
    return 0;
  }

  /** Unsupported voxels (= what would still fall) — 0 once a collapse has fully settled. */
  debugFloatingCount(): number {
    return this.debugUnsupportedCount();
  }

  /** Times the heavy per-event operations on the current grid (perf diagnosis). */
  debugProfile(): Record<string, number> {
    const t0 = performance.now();
    this.mesher.setRingBounds(CITY_VOX.x1, CITY_VOX.z1); this.mesher.rebuild(this.grid); this.seedMeshChunks();
    const meshMs = performance.now() - t0;
    const t1 = performance.now();
    this.collider.rebuildAll(this.grid);
    const colMs = performance.now() - t1;
    let bodies = 0, dyn = 0;
    this.physics.world.forEachRigidBody((b) => { bodies++; if (b.isDynamic()) dyn++; });
    return {
      voxels: this.grid.size,
      bodies, dyn,
      debris: this.debris.count,
      meshMs: +meshMs.toFixed(1),
      colMs: +colMs.toFixed(1),
    };
  }

  debugCubeCount(): number {
    return this.gpu ? this.gpu.debugCubeCount() : 0;
  }

  debugEmit(x: number, y: number, z: number, kind: ParticleKind, strength: number, speed: number, life: number): void {
    this.sink.burst(x, y, z, { count: 0, color: 0x888888, speed, kind, strength, life, buoyancy: 0, windCoupling: 0 });
  }

  debugProbe(minX: number, maxX: number, minZ: number, maxZ: number) {
    return this.gpu ? this.gpu.debugProbe(minX, maxX, minZ, maxZ) : null;
  }

  debugSetRepel(on: boolean): void {
    this.gpu?.setRepel(on);
  }

  debugSpread(cx: number, cz: number, radius: number) {
    return this.gpu ? this.gpu.debugSpread(cx, cz, radius) : null;
  }

  debugTimeBookkeeping(iters: number): number {
    return this.gpu ? this.gpu.debugTimeBookkeeping(iters) : -1;
  }

  /** Advances the GPU sim deterministically (fixed dt, no wind) — for headless tests. */
  debugStepParticles(steps: number): void {
    if (!this.gpu) return;
    const noWind = { x: 0, y: 0, z: 0 };
    let t = this.time;
    for (let i = 0; i < steps; i++) {
      t += 0.033;
      this.gpu.update(0.033, t, noWind);
    }
    this.time = t;
  }

  // --- scene setup -------------------------------------------------------

  private buildGround(): void {
    const ground = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.95).setCollisionGroups(GROUP_GROUND),
      ground,
    );
    // grassy terrain: a big subdivided plane — DEAD FLAT everywhere (city + the field out to the forest ring),
    // mottled with muted greens so it reads as grass/ground without a texture. Purely visual; the physics floor
    // above is a flat slab. Higher SEG so the 3.5 m streets resolve. No displacement → the whole map is level.
    const SEG = 160, SIZE = 400;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x3f4a2e), asphalt = new THREE.Color(0x2b2d31), concrete = new THREE.Color(0x6b675e), tint = new THREE.Color();
    const noise = (x: number, z: number) => Math.sin(x * 0.05) * Math.cos(z * 0.045) + 0.5 * Math.sin(x * 0.12 + z * 0.1);
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = -pos.getY(i);                                  // plane local → world XZ
      const cls = groundClass(wx / VOXEL, wz / VOXEL);                            // street / plot / outside
      const n = 0.5 + 0.5 * noise(wx * 1.7, wz * 1.7);                            // colour mottle only — no height
      if (cls === "street") tint.copy(asphalt).multiplyScalar(0.82 + 0.18 * n);   // dark asphalt with faint lane variation
      else if (cls === "plot") tint.copy(concrete).multiplyScalar(0.8 + 0.2 * n); // concrete apron under buildings
      else tint.copy(grass).multiplyScalar(0.72 + 0.28 * n);                      // mottled grass beyond the city
      colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.renderer.scene.add(mesh);
  }

  private spawnInitialProps(): void {
    for (let i = 0; i < 6; i++) {
      this.spawnCrate(5 + (i % 3) * 0.65, 0.31 + Math.floor(i / 3) * 0.62, -3 + (i % 3) * 0.1);
    }
  }

  /** Rebuilds the whole world from a seed so every client in a room is byte-identical (full sync).
   *  VS drops the loose crates (dynamic props would diverge across clients). */
  private rebuildWorld(seed: number, withProps: boolean): void {
    setMapSize(this.mapSize); // rescale the world to the room's chosen size BEFORE building (like setWorldSeed)
    setWorldSeed(seed);
    this.worldSeed = seed >>> 0; // same seed drives world gen AND every per-event destruction RNG
    for (const p of this.props) { this.physics.world.removeRigidBody(p.body); this.renderer.scene.remove(p.mesh); }
    this.props.length = 0;
    this.grid.clear();
    buildDefaultScene(this.grid);
    if (this.mode === "dvh") {
      buildObjectives(this.grid); // a destructible core per team
      this.droneKills = 0; this.humanKills = 0; this.matchOver = false; this.hud.hideWin();
      this.prevDroneHp = 1; this.prevHumanHp = 1; // fresh bases → reset the under-attack alert baselines
    }
    this.baseModels.build(this.mode === "dvh" ? OBJECTIVE_SITES : []); // decorative team HQ over each base (dvh only)
    (this.interiorLights ??= new InteriorLights(this.renderer.scene)).build(placedBuildings(), this.interiorLightBudget());
    this.ensureFlashlight(); // pre-create at intensity 0 so the first F toggle causes no light-count recompile
    this.mesher.setRingBounds(CITY_VOX.x1, CITY_VOX.z1); this.mesher.rebuild(this.grid); this.seedMeshChunks();
    this.heightField.rebuild(this.grid);
    this.gpu?.setHeightField(this.heightField.texture, this.heightField.origin, this.heightField.size);
    this.rebuildGasTanks();
    this.collider.clear();
    this.streamColliders(true);
    this.structureDirty = false;
    this.pendingFall.length = 0; // drop any in-flight collapse wave from the old grid
    this.grid.baselineGen();     // window/door cuts are world-gen, not destruction → don't sync them
    this.syncedFromPeer = false; // a fresh world → accept one reconciliation snapshot from a peer again
    // Ammo-supply crates for the soldiers, on a deterministic per-room grid (same on every client). Only
    // in combat modes — the free sandbox has no ammo, so no crates. Rebuilding resets every crate to live.
    this.ammoCrates.build(this.mode !== "free" ? ammoBoxSites(this.worldSeed) : []);
    this.medkits.build(this.mode !== "free" ? medkitSites(this.worldSeed) : []);
    this.recentBlasts.length = 0; // fresh world → drop stale explosion noise
    this.smokeClouds.length = 0;  // drop any smoke still hanging from the ended match (would block LOS into the replay)
    if (withProps) this.spawnInitialProps();
    this.spawnPlayerInBuilding();
  }

  /** Drops the player in the clear perimeter band, scaled to the map size + player count (PvP splits the
   *  teams to opposite sides; co-op spreads around all edges), facing the city centre. */
  private spawnPlayerInBuilding(): void {
    const team: 0 | 1 | null = this.mode === "dvh" ? this.myTeam : null;
    const slots = MAP_SIZES[this.mapSize].players;
    const s = playerSpawn(CITY_VOX.x1, CITY_VOX.z1, VOXEL, team, Math.max(0, this.net.id - 1), slots);
    this.player.spawn(s.x, s.y, s.z, s.yaw);
  }

  /** Auto-balanced team for a player who didn't pick one: split by JOIN ORDER in the roster (even index →
   *  Rojo, odd → Azul) so two players always land on opposite sides — robust to id gaps from reconnects,
   *  unlike raw id parity. Deterministic across clients (same roster → same split). Headless → id parity. */
  private autoTeam(): Team {
    const ids = this.lobby.players.map((p) => p.id).sort((a, b) => a - b);
    const idx = ids.indexOf(this.net.id);
    return (idx >= 0 ? idx % 2 : this.net.id % 2) as Team;
  }

  private spawnCrate(x: number, y: number, z: number): void {
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setAngularDamping(0.3),
    );
    body.userData = { area: 0.36, cd: 1.05, kind: "crate" };
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.3, 0.3, 0.3).setDensity(500).setFriction(0.8).setRestitution(0.1),
      body,
    );
    const mesh = new THREE.Mesh(this.crateGeo, this.crateMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.renderer.scene.add(mesh);
    this.props.push({ body, mesh });
  }

  // --- destruction -------------------------------------------------------

  private markAllDirty(): void {
    this.rebuildAllColliders = true;
    this.rebuildGasTanks();
  }

  // Dirty a single COLLIDER chunk (cx,cy,cz in 32-chunk coords) and its parent RENDER chunk. Mesh and
  // collider now use different chunk sizes, so each edit dirties both grids: the 32³ collider chunk
  // (debounced) and the 64³ render chunk that contains it (rebuilt promptly). gen bumps per kind so any
  // in-flight cook for the old state is dropped when it returns.
  private markColChunk(cx: number, cy: number, cz: number): void {
    const colCK = packKey(cx, cy, cz);
    this.dirtyCol.set(colCK, this.time);
    this.cookService.touch(colCK, "collider");
    const R = MESH_CHUNK_RATIO;
    const meshCK = packKey(Math.floor(cx / R), Math.floor(cy / R), Math.floor(cz / R));
    this.dirtyChunks.add(meshCK);        // mesh: rebuilt promptly (visual)
    this.cookService.touch(meshCK, "mesh");
  }

  private markChunk(x: number, y: number, z: number): void {
    this.markColChunk(chunkCoord(x), chunkCoord(y), chunkCoord(z));
  }

  private markRegion(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    for (let cx = chunkCoord(x0); cx <= chunkCoord(x1); cx++)
      for (let cy = chunkCoord(y0); cy <= chunkCoord(y1); cy++)
        for (let cz = chunkCoord(z0); cz <= chunkCoord(z1); cz++) {
          this.markColChunk(cx, cy, cz);
        }
  }

  private markSphere(x: number, y: number, z: number, radius: number): void {
    const [x0, y0, z0] = VoxelGrid.worldToVoxel(x - radius, y - radius, z - radius);
    const [x1, y1, z1] = VoxelGrid.worldToVoxel(x + radius, y + radius, z + radius);
    this.markRegion(x0, y0, z0, x1, y1, z1);
  }

  /**
   * Collision LOD: keep building colliders only for non-empty chunks within COLLIDER_RADIUS of the
   * player, streaming them in/out as the player moves. The broadphase therefore only ever holds a
   * few hundred static colliders instead of tens of thousands — the cost is independent of how big
   * the building is. (Far destruction still works: the grid drives collapse, and colliders are
   * built from the up-to-date grid when the player gets there.)
   */
  private streamColliders(initial = false): void {
    const p = this.player.camera.position;
    const pcx = chunkCoord(Math.floor(p.x / VOXEL)), pcy = chunkCoord(Math.floor(p.y / VOXEL)), pcz = chunkCoord(Math.floor(p.z / VOXEL));
    const R = Game.COLLIDER_RADIUS;
    // Build AT MOST ONE collider chunk per frame while streaming (the initial full build is exempt).
    // Adding a chunk's colliders forces Rapier to re-optimise the static broadphase on the NEXT world.step,
    // and that cost scales with how many were added in the SAME step (the game measured 1 chunk ≈ no churn,
    // 4 ≈ +14ms, 8 ≈ +25ms). Several-in-one-frame is exactly the "jalón al moverse" (perf.log: phys worstMs
    // ~20ms with debris 0). One per frame keeps every re-opt tiny; the 16 m collider radius gives ample lead
    // time to fill the bubble as the player crosses chunk boundaries.
    const _cs0 = performance.now();
    let built = 0;
    build:
    for (let cx = pcx - R; cx <= pcx + R; cx++)
      for (let cy = pcy - R; cy <= pcy + R; cy++)
        for (let cz = pcz - R; cz <= pcz + R; cz++) {
          if (this.collider.hasChunk(cx, cy, cz) || !this.grid.chunkNonEmpty(cx, cy, cz)) continue;
          if (!initial && built >= 1) break build; // one chunk/frame → the broadphase re-opt stays tiny
          this.collider.rebuildChunk(this.grid, cx, cy, cz);
          built++;
        }

    const far = R + 1; // hysteresis so chunks at the edge don't thrash in/out. R+1 (was R+2): perf.log showed
    // the R+2 ring retained ~42 chunks / 2145 colliders even at R=1 (a 7³ region) — that big static set kept
    // phys worstMs at 12-20 ms AND churned GC as chunks streamed. R+1 halves the retained set; one CHUNK (8 m)
    // of hysteresis is ample to stop boundary thrash at drone speed.
    const drop = this._dropScratch; drop.length = 0; // reused: streamColliders runs every frame → no per-frame array alloc
    for (const ck of this.collider.builtChunks()) {
      const cx = (ck % KEY_SPAN) - KEY_HALF, cy = (Math.floor(ck / KEY_SPAN) % KEY_SPAN) - KEY_HALF, cz = Math.floor(ck / (KEY_SPAN * KEY_SPAN)) - KEY_HALF;
      if (Math.abs(cx - pcx) > far || Math.abs(cy - pcy) > far || Math.abs(cz - pcz) > far) {
        drop.push(ck);
        // Cap drops/frame like the build side: removing a whole trailing face (~9 chunks) of colliders in one
        // frame forces a big broadphase re-opt on the next world.step (the "tirón al moverse"). Dropped chunks
        // are already ≥1 chunk outside collision range (hysteresis), so lingering a few frames is invisible.
        if (drop.length >= 2) break;
      }
    }
    for (const ck of drop) {
      this.collider.removeChunk((ck % KEY_SPAN) - KEY_HALF, (Math.floor(ck / KEY_SPAN) % KEY_SPAN) - KEY_HALF, Math.floor(ck / (KEY_SPAN * KEY_SPAN)) - KEY_HALF);
    }
    const _cd = performance.now() - _cs0;
    this.prof.colTotal += _cd; if (_cd > this.prof.colMax) this.prof.colMax = _cd;
  }

  /** After a FULL mesh rebuild (everything built), the mesher's built chunks ARE every non-empty render
   *  chunk — snapshot them as the streaming universe. streamMeshes then trims to the bubble over the next
   *  frames and rebuilds chunks on return. Cheap: iterates built chunks (hundreds), not the grid. */
  private seedMeshChunks(): void {
    this.meshChunks = new Set(this.mesher.builtChunks());
  }

  /**
   * Mesh LOD / streaming: keep Three.js meshes only for render chunks within RENDER_DIST of the player;
   * dispose the far ones. Rendered geometry AND the live mesh-object count then track the ~190 m bubble,
   * not the city size — so 5× buildings / 50× trees cost the same object graph as 1× (the grid, which is
   * always current, drives destruction; a far chunk's mesh is just rebuilt fresh from it on return). Mirrors
   * streamColliders: build a small budget/frame, drop with a one-chunk hysteresis. Render-only → never
   * touches the grid or determinism.
   */
  private streamMeshes(): void {
    const p = this.player.camera.position;
    const HALF = (MESH_CHUNK / 2) * VOXEL;
    const R2 = this.renderDist * this.renderDist;
    const dropR = this.renderDist + MESH_CHUNK * VOXEL;     // +1 render chunk (16 m) of hysteresis
    const dropR2 = dropR * dropR;
    // BUILD near non-empty chunks that aren't built and aren't already cooking (off-thread → tiny main-thread cost)
    let built = 0;
    for (const ck of this.meshChunks) {
      if (this.mesher.hasChunk(ck) || this.meshInFlight.has(ck)) continue;
      const mcx = (ck % KEY_SPAN) - KEY_HALF, mcy = (Math.floor(ck / KEY_SPAN) % KEY_SPAN) - KEY_HALF, mcz = Math.floor(ck / (KEY_SPAN * KEY_SPAN)) - KEY_HALF;
      const dx = mcx * MESH_CHUNK * VOXEL + HALF - p.x, dz = mcz * MESH_CHUNK * VOXEL + HALF - p.z;
      if (dx * dx + dz * dz > R2 && !this.isRingChunk(mcx, mcz)) continue; // the ring (map seal) always builds — never a see-through gap
      const keys = this.grid.meshChunkVoxelKeys(mcx, mcy, mcz);
      if (keys.length === 0) continue;                     // chunk carved to nothing → nothing to build
      const matIdx = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) matIdx[i] = this.grid.materialIndexAt(keys[i]);
      this.meshInFlight.add(ck);
      this.cookService.requestMesh(ck, Int32Array.from(keys), matIdx);
      if (++built >= 3) break;                             // budget: ≤3 requests/frame so a fast crossing never stalls
    }
    // DISPOSE far built chunks (collect then remove — don't mutate the Map mid-iteration). Budget the drop so
    // the one-time post-load trim (everything built → bubble) spreads over frames instead of a dispose hitch.
    const drop = this._meshDrop; drop.length = 0;
    for (const ck of this.mesher.builtChunks()) {
      const mcx = (ck % KEY_SPAN) - KEY_HALF, mcz = Math.floor(ck / (KEY_SPAN * KEY_SPAN)) - KEY_HALF;
      if (this.isRingChunk(mcx, mcz)) continue;            // NEVER stream out the perimeter ring — it seals the map on every side
      const dx = mcx * MESH_CHUNK * VOXEL + HALF - p.x, dz = mcz * MESH_CHUNK * VOXEL + HALF - p.z;
      if (dx * dx + dz * dz > dropR2) { drop.push(ck); if (drop.length >= 12) break; }
    }
    for (const ck of drop) this.mesher.disposeChunk(ck);
  }

  /** A render chunk of the indestructible perimeter ring: its centre sits OUTSIDE the city footprint. These
   *  are the map's boundary seal (hedge + treeline) — they must never stream out or distance-cull, or the far
   *  wall disposes on a big map and you see straight through that side. Cheap: the ring is a thin O(perimeter) band. */
  private isRingChunk(mcx: number, mcz: number): boolean {
    const cx = mcx * MESH_CHUNK + (MESH_CHUNK >> 1), cz = mcz * MESH_CHUNK + (MESH_CHUNK >> 1);
    return cx < 0 || cx > CITY_VOX.x1 || cz < 0 || cz > CITY_VOX.z1;
  }

  private explodeAt(x: number, y: number, z: number, radius: number, power: number, broadcast = false, by = 0, hitBots = true, srcTeam?: number): void {
    // Quantize to the wire precision AT SOURCE, so this client carves with the EXACT numbers every peer
    // receives — otherwise a <1cm float mismatch flips crater-edge voxels (the lobe test at carve.ts is a
    // hard cutoff) and the per-event RNG seed diverges. Math.round (not toFixed → stable on negatives).
    x = q2(x) / 100; y = q2(y) / 100; z = q2(z) / 100; radius = q2(radius) / 100;
    if (broadcast && hitBots && this.hosting) this.recentBlasts.push({ x, z, t: this.time, loud: Math.min(80, 28 + radius * 12) }); // host-only (it prunes + reads); PLAYER blast → loud noise, AI blasts (hitBots=false) don't lure the swarm
    const seed = eventSeed(this.worldSeed, EVT.EXPLODE, q2(x), q2(y), q2(z), q2(radius), power | 0);
    // A player-initiated blast is authoritative: broadcast its (already quantized) position so EVERY
    // client carves identically. Cascades (gas chains, collapse) are deterministic on the synced grid,
    // so they run locally on each client and are NOT broadcast (broadcast stays false for those calls).
    if (broadcast && this.net.connected) {
      this.net.send({ t: "explode", x, y, z, r: radius, p: power, tm: this.myTeam }); // tm → PvP friendly-fire gate
    }
    { const pp = this.player.camera.position; const d = Math.hypot(pp.x - x, pp.y - y, pp.z - z);
      this.audio.explosion(power, d);
      this.trauma = addTrauma(this.trauma, Math.min(0.9, (power / 3000) / (1 + d * d * 0.03))); } // blast kicks the camera; near = heavy, far = ripple
    const { removed } = explode(this.physics, this.targets, x, y, z, radius, power, seed, (fx, fy, fz, r) => this.addFlash(fx, fy, fz, r));
    if (removed > 0) {
      this.markSphere(x, y, z, radius);
      this.structureDirty = true; // re-solve the cell support graph next frame
    }
    this.projectiles.detonateNear(x, y, z, radius * 1.6); // a blast sets off any missile it reaches
    this.detonateGasTanks();

    // a blast near our own drone damages it (each client damages itself → consistent across peers)
    {
      const p = this.player.camera.position;
      const dr = radius * 1.5;
      const dist = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (dist < dr && !this.friendlyFire(srcTeam)) { this.recordDamager(by); this.damageDrone(Math.round((1 - dist / dr) * 55), x, z); }
    }
    // co-op (host, player weapons only): the blast SHREDS any AI drone in range — the soldier's missile +
    // grenade launcher now actually kill bots. `hitBots` is false for a DRONE's own grenade (no friendly fire).
    if (hitBots && this.hosting && this.swarm) this.explodeBots(x, y, z, radius * 1.4);
  }

  /** Host-authoritative: damage every AI bot within `r` of a blast (distance-scaled), killing those it drops. */
  private explodeBots(x: number, y: number, z: number, r: number): void {
    for (const [id, p] of [...this.aiBots]) { // snapshot: onBotDead mutates aiBots mid-loop
      const dist = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (dist >= r) continue;
      const dmg = Math.max(1, Math.ceil((1 - dist / r) * 8)); // core → 8 (clears even tanky late-wave bots), edge → 1
      if (this.swarm!.damageBot(id, dmg)) this.onBotDead(id);
    }
  }

  /**
   * Coarse structural collapse. When a blast changed the grid, re-solve support over the CELL graph
   * (cheap & global → correct, no false floaters) and drop the voxels of cells that lost support —
   * a budget of cells per frame, so even a building-wide collapse spreads over frames instead of
   * stalling. Because support redistributes to neighbouring column-cells, a single blast damages
   * locally rather than toppling the whole column above it. Re-runs each frame until stable
   * (a dropped cell may unsupport the one above → cascade).
   */
  private collapseStep(): void {
    if (!this.structureDirty) return;
    const _t0 = performance.now();
    // Pure collapse tick (headless-testable) + game-side hooks: impact-mark clear + chunk dirty per fallen
    // voxel, and the GPU dust burst + VS rubble damage per wave. structureDirty follows the tick's return.
    this.structureDirty = collapseTick(
      this.grid, this.pendingFall, this.worldSeed,
      (x, y, z, mat, vx, vy, vz, rng) => this.debris.spawn(x, y, z, mat, vx, vy, vz, VOXEL / 2, rng),
      (k, x, y, z) => { this.impactMarks.clearVoxel(k); this.markChunk(x, y, z); },
      (cx, cy, cz, n, dom) => this.onCollapseWave(cx, cy, cz, n, dom),
    );
    this.recordSettle(performance.now() - _t0);
  }

  /** GPU dust burst + (in VS) rubble damage when a collapse wave drops voxels — the game-side effects. */
  private onCollapseWave(cx: number, cy: number, cz: number, n: number, dom: MaterialId): void {
    this.sink.burst(cx, cy, cz, {
      count: 0, color: 0, speed: 5, life: 12, kind: "debris",
      colorType: DEBRIS_CT[dom], strength: Math.min(0.9, 0.12 + n / 80),
    });
    if (this.mode === "vs") {
      const p = this.player.camera.position;
      if (Math.hypot(p.x - cx, p.y - cy, p.z - cz) < 3) this.damageDrone(Math.min(8, n / 18));
    }
    // a real chunk falling → a deep collapse rumble, rate-limited so a cascade doesn't machine-gun it
    if (n >= 6 && this.time > this.collapseSfxAt) {
      this.collapseSfxAt = this.time + 0.25;
      const p = this.player.camera.position;
      this.audio.structureCollapse(Math.hypot(p.x - cx, p.y - cy, p.z - cz));
    }
  }

  private recordSettle(d: number): void {
    this.prof.settleN++;
    this.prof.settleTotal += d;
    if (d > this.prof.settleMax) this.prof.settleMax = d;
  }

  /** Re-scans the grid for gas-tank clusters (call after building/loading). */
  private rebuildGasTanks(): void {
    const tankVox: Voxel[] = [];
    for (const [key, mat] of this.grid.entries()) if (mat === "gastank") tankVox.push(unpackKey(key));
    this.gasTanks = connectedComponents(tankVox).map((vox) => {
      let sx = 0, sy = 0, sz = 0;
      for (const [x, y, z] of vox) { sx += x; sy += y; sz += z; }
      const n = vox.length;
      const cx = Math.round(sx / n), cy = Math.round(sy / n), cz = Math.round(sz / n);
      const c = VoxelGrid.center(cx, cy, cz); // world centre cached once — read every frame by applyDebrisImpacts
      return { vox, cx, cy, cz, x: c.x, y: c.y, z: c.z, live: true };
    });
  }

  /**
   * A gas tank damaged past 50% detonates, and its blast can set off the next. Rather than
   * exploding the whole chain in one frame (which reads as a single blast duplicated in
   * place — e.g. up a vertical stack of tanks), each tank is QUEUED to go off a moment
   * after the previous one. updateTankChain() fires them as a staggered cascade.
   */
  private detonateGasTanks(): void {
    for (const t of this.gasTanks) {
      if (!t.live) continue;
      let remaining = 0;
      for (const [x, y, z] of t.vox) if (this.grid.get(x, y, z) === "gastank") remaining++;
      if (remaining < t.vox.length * 0.5) {
        t.live = false;
        const c = VoxelGrid.center(t.cx, t.cy, t.cz);
        this.tankChain.push({ cx: c.x, cy: c.y, cz: c.z, delay: 0.07 + this.tankChain.length * 0.05 });
      }
    }
  }

  /** Fires queued gas-tank detonations one after another (a staggered chain reaction). */
  private updateTankChain(dt: number): void {
    for (let i = this.tankChain.length - 1; i >= 0; i--) {
      const e = this.tankChain[i];
      e.delay -= dt;
      if (e.delay <= 0) {
        this.tankChain.splice(i, 1);
        this.explodeAt(e.cx, e.cy, e.cz, 3.4, 520);
      }
    }
  }


  /** A fixed pool of flash lights, created once with intensity 0. The scene's light COUNT never
   *  changes, so three.js never recompiles every material mid-game (that recompile is a ~0.5s
   *  hitch on the first explosion otherwise). */
  private initFlashes(): void {
    for (let i = 0; i < Game.MAX_FLASHES; i++) {
      const light = new THREE.PointLight(0xffd28a, 0, 10, 2);
      this.renderer.scene.add(light);
      this.flashes.push({ light, life: 0, max: 0.16, intensity: 0 });
    }
  }

  private addFlash(x: number, y: number, z: number, radius: number): void {
    // reuse a free pooled light, or steal the one with the least life left (constant light count)
    let f = this.flashes.find((fl) => fl.life <= 0);
    if (!f) f = this.flashes.reduce((a, b) => (b.life < a.life ? b : a));
    f.light.position.set(x, y, z);
    f.light.distance = radius * 8;
    f.intensity = 28 * radius;
    f.life = f.max = 0.16;
  }

  /** A muzzle pop at the gun: a small pooled-light flash + a couple of sparks. Uses the pooled lights
   *  (constant count → no material recompile), so it's free during auto-fire. Also called for REMOTE
   *  shooters at their broadcast origin, so enemy gunfire is visible/spottable at range. */
  private muzzleFlash(origin: THREE.Vector3, dir: THREE.Vector3, radius: number): void {
    const x = origin.x + dir.x * 0.7, y = origin.y + dir.y * 0.7, z = origin.z + dir.z * 0.7;
    this.flashAt(x, y, z, radius);
  }

  /** A muzzle flash at an EXACT world point (glow + a couple of sparks). */
  private flashAt(x: number, y: number, z: number, radius: number): void {
    this.addFlash(x, y, z, radius);
    this.sink.burst(x, y, z, {
      count: 2, color: 0xffd27a, speed: 3, size: 2, life: 0.07,
      buoyancy: 0, windCoupling: 0.05, kind: "spark", strength: 0.004,
    });
  }

  /** The PLAYER's own first-person muzzle flash: at the held gun's BARREL (the viewmodel) for a soldier, else
   *  at the camera muzzle (a flying drone has no held gun). Keeps the flash on the gun instead of floating at
   *  screen centre. The bullet ray still starts at the eye/crosshair — only the visual flash moves to the gun. */
  private firstPersonFlash(origin: THREE.Vector3, dir: THREE.Vector3, radius: number): void {
    const mp = this.role === "human" ? this.viewmodel.muzzleWorld(this.player.camera, this.tmpMuzzle) : null;
    if (mp) this.flashAt(mp.x, mp.y, mp.z, radius);
    else this.muzzleFlash(origin, dir, radius); // drone / no gun shown → camera-muzzle fallback
  }

  // --- input -------------------------------------------------------------

  private onMouseDown(button: number): void {
    if (button === 0) this.firing = true; // hold LMB → keep firing (see autoFire in the frame loop)
    if (this.hp <= 0) return; // dead → wait for respawn
    const origin = this.player.camera.position;
    const dir = this.player.forward(this.tmpDir).clone();

    // Combat modes (vs/dvh) use the per-team weapon loadout + ammo, not the sandbox tools.
    if (this.mode !== "free") {
      // right-click aims a SCOPED weapon down sights (applyAds reconciles it); other weapons keep firing.
      if (button === 2 && this.player instanceof Walker && WEAPONS[this.weapon].scope) { this.ads = true; return; }
      this.fireWeapon(origin, dir);
      return;
    }

    if (button === 2 && this.tool !== "build" && this.tool !== "erase") {
      this.shoot(origin, dir);
      return;
    }

    const w = roleWeapon(this.role); // drone: fast+light · human: slow+heavy
    switch (this.tool) {
      case "shoot":
        this.shoot(origin, dir);
        break;
      case "grenade":
        if (this.time >= this.grenadeReadyAt) {
          this.projectiles.launchGrenade(origin.clone(), dir, 22, false, w.powerMul);
          this.broadcastWeapon("grenade", origin, dir);
          this.grenadeReadyAt = this.time + 2 * w.cooldownMul;
        } else {
          this.hud.flash(`Granada: ${Math.ceil(this.grenadeReadyAt - this.time)}s`);
        }
        break;
      case "cannon":
        this.projectiles.launchCannonball(origin.clone(), dir, 60, false, w.powerMul);
        break;
      case "missile":
        if (this.time >= this.missileReadyAt) {
          this.projectiles.launchRocket(origin.clone(), dir, 52, false, w.powerMul);
          this.broadcastWeapon("missile", origin, dir);
          this.missileReadyAt = this.time + 1 * w.cooldownMul;
        } else {
          this.hud.flash(`Misil: ${Math.ceil(this.missileReadyAt - this.time)}s`);
        }
        break;
      case "build":
        if (button === 2) {
          this.applyEdit(eraseVoxel(this.grid, origin, dir, this.brush)); this.audio.erase();
        } else {
          this.applyEdit(placeVoxel(this.grid, origin, dir, MATERIAL_ORDER[this.matIndex], this.brush)); this.audio.place();
        }
        break;
      case "erase":
        this.applyEdit(eraseVoxel(this.grid, origin, dir, this.brush)); this.audio.erase();
        break;
    }
  }

  /** Full-auto: while LMB is held, keep firing the primary weapon at its rate — for BOTH teams. The
   *  team weapon self-gates on its cooldown (so its own fire rate sets the cadence); the sandbox bullet
   *  gets a machine-gun cadence. Grenades/missiles/build stay single-click. */
  private autoFire(): void {
    if (this.hp <= 0) return;
    if (this.projectiles.bulletCount > 40) return; // held-fire safety: don't stack unbounded bullet bodies
    const origin = this.player.camera.position;
    const dir = this.player.forward(this.tmpDir).clone();
    // cooldown-gated → full-auto, EXCEPT a bolt-action weapon (sniper): one shot per trigger pull, no auto-repeat.
    if (this.mode !== "free") { if (!WEAPONS[this.weapon].boltAction) this.fireWeapon(origin, dir); return; }
    if (this.tool === "shoot" && this.time >= this.bulletReadyAt) {
      this.bulletReadyAt = this.time + 0.09; // ~11 rounds/sec
      this.shoot(origin, dir);
      this.audio.shot("mg");
    }
  }

  private applyEdit(region: EditRegion | null): void {
    if (region) this.markRegion(region[0], region[1], region[2], region[3], region[4], region[5]);
  }

  private shoot(origin: THREE.Vector3, dir: THREE.Vector3, dmg = 0, speed = 120): void {
    this.projectiles.launchBullet(origin, dir, speed);
    this.aiHitscan(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z); // damage co-op AI drones on the shot line
    this.firstPersonFlash(origin, dir, 0.22); // muzzle glow AT the held gun's barrel (soldier) / camera (drone)
    this.trauma = addTrauma(this.trauma, 0.03); // light per-shot kick
    if (dmg > 0) this.predictHit(origin, dir); // local hit marker when our round is on an enemy
    this.broadcastWeapon("bullet", origin, dir, dmg);
  }

  /** Tells the other players we fired, so they see the projectile; `dmg` lets a bullet hurt whoever's
   *  in its line of fire (each hit peer self-applies the damage — the same model as blasts). */
  private broadcastWeapon(k: string, o: THREE.Vector3, d: THREE.Vector3, dmg = 0): void {
    if (!this.net.connected) return;
    this.net.send({
      t: "weapon", k, dmg, w: this.weapon, tm: this.myTeam, // w = weapon id (falloff); tm = shooter team (PvP FF gate)
      ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
      dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3),
    });
  }

  /** Fire the active team weapon (vs/dvh): cooldown + ammo gates, then dispatch by fire kind. */
  private fireWeapon(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const spec = WEAPONS[this.weapon];
    if (this.time < this.weaponReadyAt) return;
    if (this.time < this.reloadingUntil) return; // reloading → locked out
    if (spec.fire === "turret" && this.turrets.length >= Game.MAX_TURRETS) { // cap active sentries BEFORE spending ammo
      this.hud.flash(`🗼 Máx. ${Game.MAX_TURRETS} torretas activas`); this.audio.emptyClick(); return;
    }
    const cur = this.ammo[this.weapon];
    if (cur.mag <= 0 && cur.reserve > 0) { // dry with reserve → START a timed reload instead of firing this frame
      this.ammo[this.weapon] = reloadMag(cur, spec.magSize).ammo;
      this.reloadingUntil = this.time + reloadDuration(spec);
      this.audio.place(); this.hud.flash("🔄 Recargando…");
      this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon], classLoadout(this.role, this.myClass));
      return;
    }
    const res = tryFire(this.ammo[this.weapon], spec.magSize); // mag>0 draws a round; fully empty → not fired
    if (!res.fired) { this.hud.flash("Sin munición — recarga en tu base"); this.audio.emptyClick(); return; }
    this.ammo[this.weapon] = res.ammo;
    this.weaponReadyAt = this.time + spec.cooldown;
    const w = roleWeapon(this.role);
    switch (spec.fire) {
      case "bullet": {
        this.bloom = decayBloom(spec, this.bloom, this.time - this.lastBloomT); // lazy decay since last shot
        this.lastBloomT = this.time;
        // The perturbed dir is what shoot() traces/broadcasts, so peers replay the SAME final dir —
        // Math.random is safe here (unlike the shotgun's many locally-replayed pellets, which are seeded).
        const [sx, sy, sz] = coneSpread(dir.x, dir.y, dir.z, spreadAngle(spec, this.bloom, this.scopedNow), Math.random(), Math.random());
        this.shoot(origin, this.tmpSpread.set(sx, sy, sz), spec.playerDmg ?? 0, spec.bulletSpeed ?? 120);
        this.bloom = addBloom(spec, this.bloom);
        break;
      }
      case "shotgun":   this.fireShotgun(origin, dir, spec.pellets ?? 8, spec.playerDmg ?? 0); break;
      case "grenade":   this.projectiles.launchGrenade(origin.clone(), dir, 22, false, w.powerMul); this.broadcastWeapon("grenade", origin, dir); break;
      case "explosive": this.projectiles.launchRocket(origin.clone(), dir, 52, false, w.powerMul); this.broadcastWeapon("missile", origin, dir); break;
      case "net":       this.fireNet(origin, dir); break;
      case "smoke":     this.projectiles.launchGrenade(origin.clone(), dir, 16, false, 1, false, true); this.audio.ui(); break;
      case "swarm":     this.fireSwarm(origin, dir); break;
      case "kamikaze":  this.kamikaze(origin); break;
      case "flak":      this.fireFlak(origin, dir); break;
      case "emp":       this.fireEmp(origin, dir); break;
      case "lockon":    this.fireLockon(origin, dir); break;
      case "turret":    this.deployTurret(origin, dir); break;
    }
    if (spec.fire !== "flak" && spec.fire !== "emp" && spec.fire !== "lockon" && spec.fire !== "turret") this.audio.shot(this.weapon); // report (the new tools play their own sound)
    this.viewmodel.kick(spec.boltAction ? 0.9 : spec.pellets ? 0.8 : 0.4); // heavier kick for slow/high-impact weapons
    if (spec.boltAction) this.audio.boltCycle(); // bolt-action: rack the next round (a beat after the shot)
    this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon], classLoadout(this.role, this.myClass));
  }

  /** Shotgun: a tight bullet spread. Each pellet's grid hit is broadcast, so peers stay in sync. */
  private fireShotgun(origin: THREE.Vector3, dir: THREE.Vector3, pellets: number, dmg: number): void {
    // Seeded spread (was Math.random) so every pellet is lockstep-reproducible; each pellet's grid hit
    // is still broadcast as a `hit` for grid convergence, but the pattern itself is now deterministic.
    const rng = new Rng(eventSeed(this.worldSeed, EVT.SHOTGUN, q2(origin.x), q2(origin.y), q2(origin.z), q3(dir.x), q3(dir.y), q3(dir.z)));
    let hitBot = false;
    for (let i = 0; i < pellets; i++) {
      const d = new THREE.Vector3(
        dir.x + rng.centered(0.09),
        dir.y + rng.centered(0.09),
        dir.z + rng.centered(0.09),
      ).normalize();
      this.projectiles.launchBullet(origin, d);
      // co-op: each pellet can down a bot up close (wall-checked); the shotgun now actually hits drones
      if (this.hitBotAlongRay(origin.x, origin.y, origin.z, d.x, d.y, d.z, 30, 1)) hitBot = true;
    }
    if (hitBot) { this.hud.hitMarker("hit"); this.audio.hitMarker(false); }
    this.firstPersonFlash(origin, dir, 0.34); // bigger pop, at the gun barrel
    this.trauma = addTrauma(this.trauma, 0.12); // heavy shotgun kick
    if (dmg > 0) this.predictHit(origin, dir);
    this.broadcastWeapon("bullet", origin, dir, dmg); // one hitscan carries the burst's player damage
  }

  /** Net launcher: a slow, weak ensnaring projectile (functional stand-in for a drone-catching net). */
  private fireNet(origin: THREE.Vector3, dir: THREE.Vector3): void {
    this.projectiles.launchGrenade(origin.clone(), dir, 26, false, 0.3);
    this.broadcastWeapon("grenade", origin, dir);
  }

  /** Kamikaze: the drone self-detonates in a big blast (and dies with it). */
  private kamikaze(origin: THREE.Vector3): void {
    this.explodeAt(origin.x, origin.y, origin.z, 5, 1400, true);
    this.damageDrone(9999);
  }

  /** Human-only melee (rifle butt): short cone attack. Broadcasts so peers self-damage if in reach and
   *  see the swing; the swing whoosh plays locally, the thud on whoever it connects with. */
  private meleeAttack(): void {
    if (!(this.player instanceof Walker) || this.hp <= 0 || this.time < this.meleeReadyAt) return;
    this.meleeReadyAt = this.time + 0.7;
    this.audio.melee();
    const o = this.player.camera.position, d = this.player.forward(this.tmpDir).clone();
    if (this.net.connected) {
      this.net.send({
        t: "melee", dmg: 55, range: 2.4, tm: this.myTeam,
        ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
        dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3),
      });
    }
  }

  private selectWeapon(w: Weapon): void {
    this.weapon = w;
    this.bloom = 0;     // spread bloom never carries over to the next weapon
    this.reloadingUntil = 0; // switching weapons CANCELS the reload lock
    this.zoomLevel = 0; // a fresh weapon starts at its base zoom stop
    this.viewmodel.setWeapon(w, this.role, this.myClass); // swap the held model
    this.audio.weaponSwitch();
    this.hud.setWeapon(this.role, w, this.ammo[w], classLoadout(this.role, this.myClass));
    this.hud.flash(`${WEAPONS[w].icon} ${WEAPONS[w].name}`);
  }

  private scopedNow = false; // last applied scope state — the HUD overlay is only touched on a transition
  private zoomLevel = 0;     // scoped zoom-stop index (the wheel cycles it while aiming); reset on weapon switch
  private scopeFov = 0;      // the active scope FOV (drives the optical scope render pass) while scopedNow
  /** Reconcile aim-down-sights each frame from the raw RMB intent: only a LIVING SOLDIER holding a SCOPED
   *  weapon actually scopes in. Switching weapons, dying, or being a drone drops it (self-healing). */
  private applyAds(): void {
    const w = this.player;
    const mags = WEAPONS[this.weapon].zoomMags;
    const scoped = w instanceof Walker && this.ads && this.hp > 0 && !!mags;
    // scope FOV that yields the requested ×mag INSIDE the small scope circle (see SCOPE_CIRCLE_R): a higher
    // mag → a narrower FOV → more magnification within the glass. The main view FOV is untouched.
    const mag = mags ? mags[Math.min(this.zoomLevel, mags.length - 1)] : 1;
    this.scopeFov = scoped ? (HUMAN_FOV * SCOPE_CIRCLE_R) / mag : 0;
    if (w instanceof Walker) w.setAds(scoped ? this.scopeFov : null);
    if (scoped !== this.scopedNow) { this.scopedNow = scoped; this.hud.setScope(scoped); }
  }

  private megaBombReadyAt = 0; // cooldown: one 9k-voxel blast is a big rebuild, don't let B spam it
  /** 💣 Mega bomb (free mode, B): a huge explosion where you're aiming — far bigger than any weapon.
   *  Broadcast so every client sees the same crater + collapse (the blast lives in the synced grid). */
  private megaBomb(): void {
    if (this.time < this.megaBombReadyAt) return;
    this.megaBombReadyAt = this.time + 2.5;
    const o = this.player.camera.position, d = this.player.forward(this.tmpDir).clone();
    const hit = this.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 160);
    const dist = hit ? hit.distance : 42;
    this.explodeAt(o.x + d.x * dist, o.y + d.y * dist, o.z + d.z * dist, 8, 3000, true);
    this.hud.flash("💣 ¡MEGA BOMBA!");
  }

  /** True when within recharge range of EITHER of our team's two bases. */
  // Site centres cached per world: buildObjectives REASSIGNS the OBJECTIVE_SITES array, so an identity
  // check on the array reference recomputes exactly once per world build (nearOwnBase runs every frame).
  private baseSitesRef: typeof OBJECTIVE_SITES | null = null;
  private readonly baseCenters: { team: "drone" | "human"; x: number; y: number; z: number }[] = [];
  private nearOwnBase(): boolean {
    if (this.baseSitesRef !== OBJECTIVE_SITES) {
      this.baseSitesRef = OBJECTIVE_SITES;
      this.baseCenters.length = 0;
      for (const site of OBJECTIVE_SITES)
        this.baseCenters.push({ team: site.team, x: (site.x0 + site.x1) * 0.5 * VOXEL, y: (site.y0 + site.y1) * 0.5 * VOXEL, z: (site.z0 + site.z1) * 0.5 * VOXEL });
    }
    const p = this.player.camera.position;
    for (const site of this.baseCenters) {
      if (site.team !== this.role) continue;
      const dx = p.x - site.x, dy = p.y - site.y, dz = p.z - site.z;
      if (dx * dx + dy * dy + dz * dz < 64) return true; // 8² — same verdict as hypot < 8
    }
    return false;
  }

  /** Full arsenal refill (base + respawn): every weapon in the loadout to full mag + full reserve. NO battery. */
  private resupplyAmmo(): boolean {
    let gained = false;
    for (const w of classStats(this.role, this.myClass).loadout) { // read-only walk — no classLoadout .slice() per call
      const spec = WEAPONS[w], cur = this.ammo[w];
      if (cur.mag < spec.magSize || cur.reserve < spec.maxReserve) {
        gained = true;
        cur.mag = spec.magSize; cur.reserve = spec.maxReserve; // same values as fullAmmo(spec), in place
      }
    }
    return gained;
  }

  /** A STREET crate gives LIMITED ammo for the PRIMARY weapon ONLY (slot 0) — not the whole arsenal. Tops the
   *  mag up and adds HALF a reserve (grenades / turret / flak / missiles restock ONLY at your base). Returns
   *  whether anything was gained, so a crate isn't wasted on an already-stocked primary. */
  private resupplyAmmoCrate(): boolean {
    const w = classStats(this.role, this.myClass).loadout[0]; // primary gun only → "solo cierta munición, no todo ni cualquiera"
    const spec = WEAPONS[w], cur = this.ammo[w];
    if (cur.mag >= spec.magSize && cur.reserve >= spec.maxReserve) return false;
    cur.mag = spec.magSize;                                                                                 // top up the mag
    cur.reserve = Math.min(spec.maxReserve, cur.reserve + Math.max(1, Math.ceil(spec.maxReserve / 2)));     // + half a reserve, capped ("más limitado")
    return true;
  }

  /** Refill all weapons + battery (on respawn, and whenever standing in the base). */
  private resupply(): void {
    this.resupplyAmmo();
    this.reloadingUntil = 0; // fresh mags everywhere → any in-progress reload is moot
    this.battery = BATTERY_MAX;
    this.bandages = BANDAGE_MAX; // bandages restock at the base + on respawn
  }

  /** Channeled self-heal (soldier only): hold B, standing still and not firing, for BANDAGE_DUR seconds to
   *  spend one bandage and restore BANDAGE_HEAL HP. Moving, firing or taking a hit cancels it (no partial). */
  private bandageFrame(dt: number): void {
    if (this.mode === "free") return;
    if (!(this.player instanceof Walker)) { this.bandageT = 0; this.bandaging = false; this.hud.setBandages(-1, false, 0); this.hud.setStamina(-1, false); return; } // drones don't bandage / tire
    this.hud.setStamina(this.player.staminaFrac, this.player.sprintExhausted); // soldier sprint reserve
    const inp = this.input;
    const still = !(inp.isDown("keyw") || inp.isDown("keya") || inp.isDown("keys") || inp.isDown("keyd") || inp.isDown("space"));
    const active = inp.isDown("keyb")
      && this.bandages > 0 && this.hp > 0 && this.hp < this.myMaxHp() && still && !this.firing;
    const r = bandageStep(this.bandageT, active, dt);
    this.bandageT = r.t;
    this.bandaging = active;
    if (r.done) {
      this.hp = Math.min(this.myMaxHp(), this.hp + BANDAGE_HEAL);
      this.bandages--;
      this.audio.heal(); // warm heal chime
      this.hud.setHealth(this.hp, this.myMaxHp(), true);
      this.hud.flash("🩹 Vendado");
    }
    const canHeal = this.hp < this.myMaxHp() && this.bandages > 0; // hurt and have a charge → prompt "B — CURARTE"
    this.hud.setBandages(this.bandages, this.bandaging, this.bandageT / BANDAGE_DUR, canHeal, this.medkitNear);
  }

  /** Soldiers (on foot) resupply AMMO by walking over a street crate. The pickup is broadcast so every
   *  client hides the same crate; crates respawn after a cooldown. Drones recharge at their base instead. */
  private ammoFrame(): void {
    if (this.mode === "free") return;
    this.ammoCrates.update(this.time);                            // tick respawns on every client
    if (!(this.player instanceof Walker) || this.hp <= 0) return; // only a living soldier grabs crates
    const p = this.player.camera.position;
    const i = this.ammoCrates.nearestLive(p.x, p.z);
    if (i < 0 || !this.resupplyAmmoCrate()) return;               // nothing near, or primary already full → don't waste it
    this.ammoCrates.take(i, this.time);
    if (this.net.connected) this.net.send({ t: "ammo", i });
    this.hud.flash("📦 Munición (arma principal)");
    this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon], classLoadout(this.role, this.myClass));
    this.audio.pickup(); // bright pickup pluck
  }

  /** Soldiers restock BANDAGES by walking over a red medkit crate (broadcast like ammo so peers hide the
   *  same one; respawns on a cooldown). Drones don't bandage. */
  private medkitFrame(): void {
    this.medkitNear = false;
    if (this.mode === "free") return;
    this.medkits.update(this.time);                               // tick respawns on every client
    if (!(this.player instanceof Walker) || this.hp <= 0 || this.bandages >= BANDAGE_MAX) return;
    const p = this.player.camera.position;
    this.medkitNear = this.medkits.nearestLive(p.x, p.z, 7) >= 0; // a live medkit within 7 m → HUD cue to grab it
    const i = this.medkits.nearestLive(p.x, p.z);
    if (i < 0) return;
    this.medkits.take(i, this.time);
    this.bandages = Math.min(BANDAGE_MAX, this.bandages + 2);
    if (this.net.connected) this.net.send({ t: "medkit", i });
    this.hud.flash("🩹 Botiquín recogido");
    this.audio.pickup(); // bright pickup pluck
  }

  /** Per-frame combat upkeep: base recharge, drone battery drain + power-out death, HUD panels. */
  private combatFrame(dt: number): void {
    if (this.mode === "free") return;
    const nearBase = this.nearOwnBase();
    if (nearBase) this.resupply();
    // Battery is a dvh mechanic — it needs the base to recharge, and dvh is where the bases exist.
    if (this.mode === "dvh" && this.player instanceof Player) {
      if (!nearBase) this.battery = Math.max(0, this.battery - batteryDrain(this.player.speed(), dt));
      if (this.battery <= 0 && this.hp > 0) { this.damageDrone(9999); this.hud.flash("¡Batería agotada — el dron cae!"); }
      if (this.battery < 20 && this.battery > 0 && this.time > this.lowBatBeepAt) { this.audio.lowBattery(); this.lowBatBeepAt = this.time + 1; }
      this.hud.setBattery(this.battery / BATTERY_MAX);
    } else {
      this.hud.setBattery(-1); // humans / vs: no battery gauge
    }
    // Throttle the innerHTML panels (~7 Hz). selectWeapon/fireWeapon push the weapon panel immediately,
    // so this is just the continuous refresh of ammo/K-D-A/teammate health.
    this.combatHudT -= dt;
    if (this.combatHudT <= 0) {
      this.combatHudT = 0.15;
      this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon], classLoadout(this.role, this.myClass));
      this.hud.setKDA(this.myKills, this.myAssists, this.myDeaths);
      this.hud.setTeam(this.remotes.peers(), this.myTeam);
    }
  }

  /** Our own bullet reached a voxel: broadcast the hit so every client applies the same grid change,
   *  then apply it locally. */
  private onBulletHit(hit: RayHit, dx: number, dy: number, dz: number): void {
    if (this.net.connected) {
      this.net.send({
        t: "hit", vx: hit.vx, vy: hit.vy, vz: hit.vz,
        dx: +dx.toFixed(3), dy: +dy.toFixed(3), dz: +dz.toFixed(3),
        px: +hit.point.x.toFixed(2), py: +hit.point.y.toFixed(2), pz: +hit.point.z.toFixed(2),
        nx: +hit.normal.x.toFixed(2), ny: +hit.normal.y.toFixed(2), nz: +hit.normal.z.toFixed(2),
      });
    }
    this.applyBulletHit(hit.vx, hit.vy, hit.vz, dx, dy, dz, hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z);
  }

  /** Applies a bullet hit (local or networked) to the grid — deterministic, so all clients match. */
  private applyBulletHit(
    vx: number, vy: number, vz: number, dx: number, dy: number, dz: number,
    px: number, py: number, pz: number, nx: number, ny: number, nz: number,
  ): void {
    const mat = this.grid.get(vx, vy, vz);
    if (mat === undefined) return; // already gone on this client
    const pp = this.player.camera.position;
    if (this.grid.isIndestructible(vx, vy, vz)) {
      // forest wall / gate vehicles: the round sparks off but never damages them (nada se rompe)
      this.audio.impact(mat, Math.hypot(pp.x - px, pp.y - py, pp.z - pz));
      this.sink.burst(px, py, pz, {
        count: 3, color: 0xffe9b0, speed: 2.5, size: 3, life: 0.12,
        buoyancy: 0, windCoupling: 0.1, kind: "spark", strength: 0.006,
      });
      return;
    }
    if (mat === "gastank") { this.detonateTankAt(vx, vy, vz); return; } // deterministic chain (not broadcast)
    this.audio.impact(mat, Math.hypot(pp.x - px, pp.y - py, pp.z - pz)); // material-specific hit, attenuated by distance
    const dmg = this.grid.addDamage(vx, vy, vz);
    if (dmg < MATERIALS[mat].hp) {
      this.impactMarks.add(packKey(vx, vy, vz), px, py, pz, nx, ny, nz);
      this.sink.burst(px, py, pz, {
        count: 3, color: 0xffe9b0, speed: 2.5, size: 3, life: 0.12,
        buoyancy: 0, windCoupling: 0.1, kind: "spark", strength: 0.006,
      });
      return;
    }
    this.breakVoxel(vx, vy, vz, mat, dx, dy, dz);
  }

  /** Destroys one bullet-broken voxel: a single real debris chunk + a small, brief puff. */
  private breakVoxel(vx: number, vy: number, vz: number, mat: MaterialId, dx: number, dy: number, dz: number): void {
    const c = VoxelGrid.center(vx, vy, vz);
    this.impactMarks.clearVoxel(packKey(vx, vy, vz));
    this.grid.remove(vx, vy, vz);
    this.markRegion(vx, vy, vz, vx, vy, vz);

    // Per-hit seed from the (integer) voxel key + quantized bullet direction → identical on every client.
    const rng = new Rng(eventSeed(this.worldSeed, EVT.HIT, packKey(vx, vy, vz), q3(dx), q3(dy), q3(dz)));
    const def = MATERIALS[mat];
    const sp = 2.5;
    const evx = dx * sp + rng.centered(1);
    const evy = dy * sp + 1.0 + rng.centered(1);
    const evz = dz * sp + rng.centered(1);

    if (def.shatters) {
      // glass: a few quick shards, no dust cloud
      this.sink.burst(c.x, c.y, c.z, {
        count: 8, color: def.color, speed: 4, size: 4, life: 0.35,
        buoyancy: -1, windCoupling: 0.3, kind: "spark", strength: 0.02,
      });
    } else {
      // one real rigid chunk of the actual material + a small, short-lived dust puff
      this.debris.spawn(c.x, c.y, c.z, mat, evx, evy, evz, VOXEL / 2, rng);
      this.sink.burst(c.x, c.y, c.z, {
        count: 6, color: 0xbfae93, speed: 1.5, size: 7, life: 0.5,
        buoyancy: -2, windCoupling: 0.5, spread: 0.25, kind: "dust", strength: 0.015,
      });
    }
    this.structureDirty = true;
  }

  /** Fast flying rubble hurts our own drone (locally) and sets off any gas tank it slams into
   *  (broadcast as an authoritative blast so every client converges). Cheap: a handful of chunks
   *  against a handful of tanks per tick. */
  private static readonly DEBRIS_IMPACT_CFG = {
    keThreshold: DEBRIS_IMPACT_KE, tankR: DEBRIS_HIT_TANK_R, droneR: DEBRIS_HIT_DRONE_R,
    dmgPerKe: 0.03, maxDronePerFrame: 25,
  };
  private applyDebrisImpacts(): void {
    const debris = this.debris.impacts();
    if (debris.length === 0) return;
    const p = this.player.camera.position;
    let drone: { x: number; y: number; z: number } | null = null;
    if (this.hp > 0) { drone = this._droneScratch; drone.x = p.x; drone.y = p.y; drone.z = p.z; }
    const out = resolveDebrisImpacts(debris, this.gasTanks, drone, Game.DEBRIS_IMPACT_CFG);
    for (const i of out.tanks) this.detonateTankByDebris(i);
    if (out.droneDamage > 0) this.damageDrone(out.droneDamage);
  }

  /** Detonates a gas tank struck by debris. Broadcast so remote clients carve the same tank
   *  (their local chain re-detects the cascade on the synced grid). */
  private detonateTankByDebris(index: number): void {
    const t = this.gasTanks[index];
    if (!t || !t.live) return;
    t.live = false;
    const c = VoxelGrid.center(t.cx, t.cy, t.cz);
    this.explodeAt(c.x, c.y, c.z, 3.4, 520, true);
  }

  /** A bullet to a gas tank detonates the whole cluster, then lets the chain run. */
  private detonateTankAt(vx: number, vy: number, vz: number): void {
    const tank = this.gasTanks.find(
      (t) => t.live && t.vox.some(([x, y, z]) => x === vx && y === vy && z === vz),
    );
    const c = tank ? VoxelGrid.center(tank.cx, tank.cy, tank.cz) : VoxelGrid.center(vx, vy, vz);
    if (tank) tank.live = false;
    this.explodeAt(c.x, c.y, c.z, 3.4, 520);
  }

  private onWheel(sign: number): void {
    // while aiming a scoped weapon, the wheel cycles its zoom stops (e.g. 1.8× ↔ 3.6×) instead of the brush
    if (this.scopedNow) {
      const mags = WEAPONS[this.weapon].zoomMags!;
      this.zoomLevel = (this.zoomLevel + (sign > 0 ? 1 : -1) + mags.length) % mags.length;
      this.hud.flash(`🔭 ${mags[this.zoomLevel]}×`);
      return;
    }
    this.brush = Math.max(0, Math.min(3, this.brush - sign));
    this.hud.flash(`Brocha ${this.brush * 2 + 1}³`);
  }

  private groundTarget(): [number, number] {
    const dir = this.player.forward(this.tmpDir);
    const cam = this.player.camera.position;
    let px: number, pz: number;
    if (dir.y < -1e-3) {
      const t = Math.min(-cam.y / dir.y, 40);
      px = cam.x + dir.x * t;
      pz = cam.z + dir.z * t;
    } else {
      px = cam.x + dir.x * 8;
      pz = cam.z + dir.z * 8;
    }
    const [vx, , vz] = VoxelGrid.worldToVoxel(px, 0, pz);
    return [vx, vz];
  }

  private onKey(code: string): void {
    if (code === "tab") { this.minimapBig = !this.minimapBig; return; } // enlarge/shrink the minimap
    if (code === "keyo") { this.openSettings(); return; } // visual settings panel (all modes)
    if (code === "keyk") { this.cycleQuality(); return; } // graphics quality (all modes)
    if (code === "keym") { this.hud.flash(this.audio.toggleMute() ? "🔇 Silencio" : "🔊 Sonido"); return; } // mute toggle
    if (code === "keyf") { this.toggleFlashlight(); return; } // flashlight (all modes/roles)
    if (this.mode !== "free") {
      // Combat (vs/dvh): digit keys pick from the CLASS weapon loadout.
      const lo = classLoadout(this.role, this.myClass);
      const idx = ["digit1", "digit2", "digit3", "digit4", "digit5", "digit6"].indexOf(code);
      if (idx >= 0 && idx < lo.length) { this.selectWeapon(lo[idx]); return; }
      if (code === "keyv") { this.meleeAttack(); return; } // melee (humans)
      if (code === "keyr") { this.reloadOrScan(); return; } // R: reload the mag (tactical → wastes the partial) if useful, else 📡 scan
      if (code === "keyh") { this.hud.toggleHelp(); return; }
      return;
    }
    switch (code) {
      case "digit1": this.setTool("shoot"); return;
      case "digit2": this.setTool("grenade"); return;
      case "digit3": this.setTool("cannon"); return;
      case "digit4": this.setTool("build"); return;
      case "digit5": this.setTool("erase"); return;
      case "digit6": this.setTool("missile"); return;
      case "keyq": this.cycleMaterial(-1); return;
      case "keye": this.cycleMaterial(1); return;
      case "keyn": { const [x, z] = this.groundTarget(); buildBuilding(this.grid, x, z); this.markAllDirty(); this.hud.flash("Edificio"); return; }
      case "keyg": { const [x, z] = this.groundTarget(); buildHouse(this.grid, x, z); this.markAllDirty(); this.hud.flash("Casa"); return; }
      case "keyu": { const [x, z] = this.groundTarget(); buildWall(this.grid, x, z); this.markAllDirty(); this.hud.flash("Muro"); return; }
      case "keyb": this.megaBomb(); return; // 💣 mega bomb (B)
      case "keyt": { const [x, z] = this.groundTarget(); buildTower(this.grid, x, z); this.markAllDirty(); this.hud.flash("Torre"); return; }
      case "keyv": { const [x, z] = this.groundTarget(); buildCar(this.grid, x, z); this.markAllDirty(); this.hud.flash("Auto"); return; }
      case "keyr": buildDefaultScene(this.grid); this.markAllDirty(); this.hud.flash("Escena inicial"); return;
      case "keyx": this.grid.clear(); this.markAllDirty(); this.hud.flash("Vaciado"); return; // (C is now descend/crouch)
      case "keyj": this.throwCrate(); return; // (F is now the flashlight)
      case "keyp": this.save(); return;
      case "keyl": this.load(); return;
      case "keyh": this.hud.toggleHelp(); return;
      case "bracketleft": this.onWheel(1); return;
      case "bracketright": this.onWheel(-1); return;
    }
  }

  private throwCrate(): void {
    const dir = this.player.forward(this.tmpDir);
    const cam = this.player.camera.position;
    const p = cam.clone().addScaledVector(dir, 1);
    this.spawnCrate(p.x, p.y, p.z);
    const prop = this.props[this.props.length - 1];
    prop.body.setLinvel({ x: dir.x * 14, y: dir.y * 14 + 2, z: dir.z * 14 }, true);
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.hud.setTool(t);
  }

  private cycleMaterial(d: number): void {
    const n = MATERIAL_ORDER.length;
    this.matIndex = (this.matIndex + d + n) % n;
    this.hud.setMaterial(MATERIAL_ORDER[this.matIndex]);
  }

  private save(): void {
    const arr: [number, number, number, string][] = [];
    for (const [key, mat] of this.grid.entries()) {
      const [x, y, z] = unpackKey(key);
      arr.push([x, y, z, mat]);
    }
    localStorage.setItem("particles.save", JSON.stringify(arr));
    this.hud.flash(`Guardado (${arr.length} vóxeles)`);
  }

  private load(): void {
    const s = localStorage.getItem("particles.save");
    if (!s) { this.hud.flash("No hay guardado"); return; }
    try {
      const arr = JSON.parse(s) as [number, number, number, string][];
      this.grid.clear();
      for (const [x, y, z, mat] of arr) this.grid.set(x, y, z, mat as never);
      this.markAllDirty();
      this.hud.flash(`Cargado (${arr.length} vóxeles)`);
    } catch {
      this.hud.flash("Guardado corrupto");
    }
  }

  // --- loop --------------------------------------------------------------

  private frame(): void {
    const now = performance.now();
    const rawDt = (now - this.last) / 1000; // TRUE frame time (unclamped) — the honest hitch size
    let dt = rawDt;
    this.last = now;
    if (dt > 0.05) dt = 0.05;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.time += dt;
    // per-frame instrumentation for the [PERF] dump: real frame ms (avg + worst = the tirón) and the
    // worst instantaneous fps in the window (a single 100 ms stall reads as fps 10 here, not the smoothed 58).
    const _fms = rawDt * 1000;
    this.prof.frameTotal += _fms; if (_fms > this.prof.frameMax) this.prof.frameMax = _fms;
    const _ifps = 1 / Math.max(rawDt, 1e-4); if (_ifps < this.prof.fpsMin) this.prof.fpsMin = _ifps;

    this.acc += dt;
    let steps = 0;
    // Adaptive substep cap: when last frame's physics was already heavy (a big collapse), a 2nd catch-up
    // step this frame would double the hitch — cap to 1 and drop the backlog below (slow-mo > stutter).
    const stepCap = maxPhysicsSteps(this.lastPhysMs);
    const _tp = performance.now();
    while (this.acc >= FIXED_DT && steps < stepCap) {
      this.physics.step(this.time);
      this.acc -= FIXED_DT;
      steps++;
    }
    const _pd = performance.now() - _tp;
    this.lastPhysMs = steps > 0 ? _pd / steps : this.lastPhysMs; // per-step cost drives the next frame's cap
    this.prof.physicsTotal += _pd; if (_pd > this.prof.physicsMax) this.prof.physicsMax = _pd;
    // never try to "catch up" a backlog — that spirals when physics is heavy.
    // Better to run slightly slow-mo for a frame than to freeze.
    if (this.acc > FIXED_DT) this.acc = 0;

    const _tctrl = performance.now();
    this.applyAds(); // reconcile scope zoom + overlay before the controller eases its FOV this frame
    if (this.hp > 0) this.player.update(dt, this.input); // FREEZE while dead: the body only moves inside update(),
    // so skipping it holds the player in place (no drift/look) until respawn repositions them
    if (this.firing && this.input.locked) this.autoFire(); // hold LMB → machine-gun the primary weapon
    // fall damage (human, >1 storey) always — a human only exists in the combat modes anyway. Drone
    // ram-impact (fast into a wall) only in combat, so the sandbox doesn't punish flying/building.
    if (this.player instanceof Walker) {
      const dmg = humanFallDamage(this.player.takeFall());
      if (dmg > 0) { this.damageDrone(dmg); this.hud.flash(`Daño de caída: ${dmg}`); }
    } else if (this.mode !== "free") {
      const imp = this.player.takeImpact();
      const dmg = droneImpactDamage(imp.speed, imp.blocked);
      if (dmg > 0) { this.damageDrone(dmg); this.hud.flash(`Impacto: ${dmg}`); }
    }
    { const _cd = performance.now() - _tctrl; this.prof.ctrlTotal += _cd; if (_cd > this.prof.ctrlMax) this.prof.ctrlMax = _cd; }
    this.netUpdate(dt);
    if (this.mode === "dvh") this.checkMatchWin(); // detect an objective destroyed this frame
    this.streamColliders(); // keep building colliders only near the player (collision LOD)
    this.streamMeshes();    // keep Three.js meshes only near the player (render LOD) → world scales flat
    this.updateTankChain(dt);
    // A projectile detonating in here calls explodeAt → carve + debris spawn + FX synchronously, so this is
    // where the blast-FRAME hitch lives (perf.log showed cpu worstMs 85-290ms hidden inside "misc"). Timed
    // separately so a spike is attributed to the blast rather than lumped as GC/untimed.
    const _tpr = performance.now();
    this.projectiles.update(dt);
    { const _pj = performance.now() - _tpr; this.prof.projTotal += _pj; if (_pj > this.prof.projMax) this.prof.projMax = _pj; }
    this.collapseStep(); // re-solve coarse support + drop a budget of fallen cells (progressive)
    const _tdb = performance.now();
    this.debris.update(dt);
    this.applyDebrisImpacts(); // fast flying rubble hurts drones and sets off gas tanks
    { const _db = performance.now() - _tdb; this.prof.debrisTotal += _db; if (_db > this.prof.debrisMax) this.prof.debrisMax = _db; }
    const _tg = performance.now();
    if (this.gpu) this.gpu.update(dt, this.time, this.physics.wind);
    else this.particles.update(dt, this.physics.wind);
    const _gd = performance.now() - _tg;
    this.prof.gpuTotal += _gd; if (_gd > this.prof.gpuMax) this.prof.gpuMax = _gd;
    this.syncProps();
    this.updateFlashes(dt);
    this.trauma = decayTrauma(this.trauma, dt); // screen shake bleeds off toward rest
    // one budget scale drives BOTH the rigid-debris cap and the GPU particle emission, so under
    // load the whole spectacle throttles together (compatibility on weak/integrated GPUs). Driven by the
    // MEASURED GPU-ms (not just smoothed fps) so it engages on the geometry-bound destruction frames.
    const budget = this.governor.update(this.fps, this.gpuTimer.latest());
    this.debris.cap = Math.round(MAX_DEBRIS * budget);
    if (this.gpu) this.gpu.emissionScale = budget;
    this.adaptiveQuality(dt); // sustained low fps → drop a preset (last resort, only once res is floored)
    // Dynamic resolution: hold ~60fps by nudging the render scale (debounced). Prefer the REAL GPU-ms from
    // the timer query (proportional → converges in ~1 tick); fall back to fps where the ext is unavailable.
    this.resTimer += dt;
    if (this.settings.resAuto && this.resTimer >= 0.4) { // manual resolution → the player owns the scale, don't touch it
      this.resTimer = 0;
      const gpuMs = this.gpuTimer.latest();
      const rs = gpuMs != null ? nextResScaleGpu(gpuMs, this.resScale) : nextResScaleFps(this.fps, this.resScale);
      // A scale change reallocs the drawing buffer — a real GPU stall (perf.log: render worstMs up to 266 ms
      // while the scale HUNTED 0.60↔0.77 every second under a wobbling GPU load). Rate-limit the realloc to at
      // most ~1 / 1.5 s for small nudges, but let a big emergency drop (a sudden GPU spike) through at once so
      // the 60 fps floor is still protected. Kills the periodic realloc stutter while flying.
      const big = Math.abs(rs - this.resScale) >= 0.15;
      if (rs !== this.resScale && (big || this.time - this.lastResChange >= 1.5)) {
        this.resScale = rs; this.renderer.setRenderScale(rs); this.lastResChange = this.time;
      }
    }
    const _tr = performance.now();
    this.rebuildDirty();
    const _rd = performance.now() - _tr;
    this.prof.rebuildTotal += _rd; if (_rd > this.prof.rebuildMax) this.prof.rebuildMax = _rd;

    // The untimed FX/HUD/combat/audio tail — historically lumped into "misc". Timed as `fx` because a
    // cpu-worstMs spike (perf.log: 90 ms with every OTHER phase low) had to be hiding here or in GC; the
    // fx-max pins which. Includes the HUD DOM writes (setStats), a known reflow-stall suspect.
    const _tfx = performance.now();
    this.combatFrame(dt); // team weapons: base recharge, drone battery, HUD panels
    this.ammoFrame();     // soldier ammo-crate pickups on the streets + crate respawns
    this.medkitFrame();   // soldier medkit pickups (bandage restock) + crate respawns
    this.bandageFrame(dt); // soldier channeled self-heal (hold B)
    this.aiFrame(dt);     // co-op: the host simulates + broadcasts the enemy drone swarm; peers render it
    this.smokeFrame();    // sustain active smoke clouds + drop expired ones (LOS blockers)
    this.miniDroneFrame(dt); // fly the soldier's interceptor swarm toward the nearest drones
    this.lockFrame(dt);      // missile lock-on: acquire the aimed drone + mark it on the HUD
    this.turretFrame(dt);    // deployed sentries auto-fire at the swarm
    this.minimapFrame(dt); // heading-up radar: friends/enemies in range + shot rays
    this.audioFrame();
    this.interiorLights?.update(this.time); // flicker the interior lights
    this.scenery?.update(dt);               // drift the clouds
    this.updateFlashlight();
    this.camFx.update(dt, {
      speed: this.player instanceof Player ? this.player.speed() : 0,
      alt: this.player.camera.position.y,
      battery: this.battery,
    });
    this.hud.update(dt);
    // death overlay + live respawn countdown — but NOT once the session is over (the game-over screen is up)
    if (!this.matchOver) { if (this.hp <= 0) this.hud.showDeath(this.respawnAt - this.time); else this.hud.hideDeath(); }
    this.statsT -= dt; // the stats readout doesn't need a 60Hz DOM write
    if (this.statsT <= 0) {
      this.statsT = 0.16;
      const gpuMs = this.gpuTimer.latest();
      this.hud.setStats(this.fps, this.debris.count, Math.hypot(this.physics.wind.x, this.physics.wind.z),
        this.renderer.renderer.info.render.calls, gpuMs ?? -1);
    }
    { const _fd = performance.now() - _tfx; this.prof.fxTotal += _fd; if (_fd > this.prof.fxMax) this.prof.fxMax = _fd; }
    this.prof.framesSimulated++;
    const _trn = performance.now();
    const cp = this.player.camera.position;
    if (!this.hidden()) { // the sim runs while hidden (Web Worker), but there's no point rendering a hidden tab
      const info = this.renderer.renderer.info;
      info.reset(); // autoReset is off (see Renderer ctor) → this frame's calls now include shadow + GPGPU passes
      // View-bubble distance culling: hide mesh chunks beyond the (live, menu-adjustable) view distance so
      // draws/triangles/shadow-casters track the bubble around the camera, not the whole city (config.ts).
      this.mesher.updateVisibility(cp.x, cp.z, this.renderDist * this.renderDist);
      // Refresh the shadow map at ~30Hz WHILE anything casts a moving shadow (player moves, geometry is
      // carved, debris/peers move) — but skip the pass ENTIRELY when the scene is static (stationary
      // player, no debris, clean grid), since the sun follows the player so the stale map stays valid.
      // Standing still to aim no longer pays the ~6ms shadow pass; a rare safety refresh unsticks it.
      const shadowActive = this.dirtyChunks.size > 0 || this.rebuildAllColliders
        || this.debris.count > 0 || this.remotes.count > 0
        || cp.distanceToSquared(this.lastShadowPos) > SHADOW_MOVE_SQ;
      if (shouldRefreshShadows(shadowActive, this.shadowSince)) {
        this.renderer.followSun(cp.x, cp.y, cp.z);
        this.renderer.refreshShadows();
        this.lastShadowPos.copy(cp);
        this.shadowSince = 0;
      } else {
        this.shadowSince++;
      }
      // Screen shake for the render only, then RESTORED — never leaks into physics or the broadcast
      // position (netUpdate already ran). Positional + roll about the view axis → aim/crosshair unmoved.
      const cam = this.player.camera;
      // walk-bob speed from the PRE-shake camera position (so screen shake doesn't read as phantom motion)
      const vmSpeed = this.vmHasPrev ? Math.hypot(cam.position.x - this.vmPrevX, cam.position.z - this.vmPrevZ) / Math.max(dt, 1e-3) : 0;
      this.vmPrevX = cam.position.x; this.vmPrevZ = cam.position.z; this.vmHasPrev = true;
      const sh = shakeOffset(this.trauma, this.time);
      cam.position.x += sh.dx; cam.position.y += sh.dy; cam.position.z += sh.dz;
      if (sh.roll !== 0) cam.rotateZ(sh.roll);
      // held weapon rides the shaken camera: soldiers only, hidden while dead / scoped / out of the match
      this.viewmodel.setVisible(this.phase === "playing" && this.role === "human" && this.hp > 0 && !this.scopedNow);
      this.viewmodel.update(dt, cam, vmSpeed);
      this.gpuTimer.begin();
      this.renderer.render(this.player.camera);
      if (this.scopedNow) this.renderer.renderScope(this.player.camera, this.scopeFov); // optical zoom inside the scope circle only
      this.gpuTimer.end();
      if (sh.roll !== 0) cam.rotateZ(-sh.roll);
      cam.position.x -= sh.dx; cam.position.y -= sh.dy; cam.position.z -= sh.dz;
      this.prof.framesRendered++;
      if (info.render.calls > this.prof.drawCalls) this.prof.drawCalls = info.render.calls;
      if (info.render.triangles > this.prof.triangles) this.prof.triangles = info.render.triangles;
    }
    const _rn = performance.now() - _trn;
    this.prof.renderTotal += _rn; if (_rn > this.prof.renderMax) this.prof.renderMax = _rn;
    // TOTAL cpu work this frame (frame() start → here). frame − cpu = the GPU/vsync WAIT: if it's big the
    // frame is GPU-bound; if cpu ≈ frame the CPU is the wall. cpu − (the timed phases) = untimed "misc" sim.
    const _cpu = performance.now() - now;
    this.prof.cpuTotal += _cpu; if (_cpu > this.prof.cpuMax) this.prof.cpuMax = _cpu;
    this.perfLog(dt);
  }

  /**
   * Always-on per-second performance dump to the console (prefix "[PERF]"), so the real bottleneck can be
   * READ from the logs instead of guessed. Everything the frame does is here: true frame time (avg + the
   * WORST frame = the tirón), the smoothed + worst-instant fps, the REAL GPU-ms (timer query — the only
   * honest GPU signal), draw calls/triangles, the per-phase CPU breakdown (physics/render-submit/mesh &
   * collider rebuild/collapse/GPU-particles/collider-streaming), the live resolution scale + quality
   * preset, JS heap, and object counts. gpu "n/a" or framesRendered 0 ⇒ the tab is backgrounded (render
   * skipped) so the numbers are meaningless — bring the game to the foreground to read real values.
   */
  private perfLog(dt: number): void {
    this.perfLogT += dt;
    if (this.perfLogT < 1) return;
    const p = this.prof;
    const f = Math.max(1, p.framesSimulated);
    const gpu = this.gpuTimer.latest();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const heap = mem ? (mem.usedJSHeapSize / 1048576) | 0 : -1;
    const dHeap = this.lastHeapMB >= 0 && heap >= 0 ? heap - this.lastHeapMB : 0; // per-window heap growth: high + = allocation churn → GC pressure
    this.lastHeapMB = heap;
    const a = (t: number) => (t / f).toFixed(2);
    const frameAvg = p.frameTotal / f, cpuAvg = p.cpuTotal / f;
    const known = (p.physicsTotal + p.ctrlTotal + p.renderTotal + p.colTotal + p.settleTotal + p.gpuTotal + p.rebuildTotal + p.projTotal + p.debrisTotal + p.fxTotal) / f;
    const misc = Math.max(0, cpuAvg - known);        // untimed remainder: netUpdate + syncProps + governor (blast/debris/fx now timed)
    const gpuWait = Math.max(0, frameAvg - cpuAvg);   // frame time NOT spent on CPU = waiting for the GPU / vsync (GPU-bound signal)
    const gs = this.grid.stats;
    const world = this.physics.world;
    const line =
      `[PERF] fps ${this.fps.toFixed(0)} min ${p.fpsMin < 999 ? p.fpsMin.toFixed(0) : "-"} | ` +
      `frame avg ${a(p.frameTotal)} max ${p.frameMax.toFixed(1)}ms | ` +
      `gpu ${gpu != null ? gpu.toFixed(1) + "ms" : "n/a"} gpuWait ${gpuWait.toFixed(2)} | draws ${p.drawCalls} tris ${(p.triangles / 1000) | 0}k | ` +
      `cpu ${cpuAvg.toFixed(2)}ms = phys ${a(p.physicsTotal)} ctrl ${a(p.ctrlTotal)} render ${a(p.renderTotal)} rebuild ${a(p.rebuildTotal)} ` +
      `collapse ${a(p.settleTotal)} blast ${a(p.projTotal)} debris ${a(p.debrisTotal)} fx ${a(p.fxTotal)} gpuPart ${a(p.gpuTotal)} colStream ${a(p.colTotal)} misc ${misc.toFixed(2)} | ` +
      // WORST single-frame cost of each phase in the window — pins a tirón: on a hitch second the culprit
      // phase's max is high; if ALL maxes are low but frame max is high, it's GC/external (watch heap swing).
      `worstMs: cpu ${p.cpuMax.toFixed(1)} render ${p.renderMax.toFixed(1)} phys ${p.physicsMax.toFixed(1)} ctrl ${p.ctrlMax.toFixed(1)} ` +
      `rebuild ${p.rebuildMax.toFixed(1)} collapse ${p.settleMax.toFixed(1)} blast ${p.projMax.toFixed(1)} debris ${p.debrisMax.toFixed(1)} fx ${p.fxMax.toFixed(1)} col ${p.colMax.toFixed(1)} gpuPart ${p.gpuMax.toFixed(1)} | ` +
      `res ${this.resScale.toFixed(2)} q ${this.quality} | heap ${heap}MB dHeap ${dHeap >= 0 ? "+" : ""}${dHeap} | ` +
      // heap breakdown: which structure is growing (traces a session-long heap climb to the exact map) + the
      // static physics load (colChunks/bodies/cols = broadphase cost that hits phys-ms even with debris 0).
      `mem: vox ${gs.vox} rem ${gs.rem} set ${gs.set} weak ${gs.weak} dmg ${gs.dmg} cell ${gs.cell} | ` +
      `colChunks ${this.collider.chunkCount} bodies ${world.bodies.len()} cols ${world.colliders.len()} | ` +
      `meshes ${this.mesher.meshCount} debris ${this.debris.count} | mode ${this.mode} hidden ${this.hidden()} | frames ${f} rendered ${p.framesRendered}`;
    console.log(line);
    // Ship it to the dev-server perf sink (→ perf.log on disk) so it can be read WITHOUT the console.
    if (typeof fetch !== "undefined") fetch("/__perf", { method: "POST", body: line, keepalive: true }).catch(() => { /* prod/no-sink: ignore */ });
    this.prof = this.profZero();
    this.perfLogT = 0;
  }

  /** Rebuilds only the geometry/colliders that changed this frame. */
  private rebuildDirty(): void {
    if (this.rebuildAllColliders) {
      this.collider.clear();           // drop all colliders…
      this.mesher.setRingBounds(CITY_VOX.x1, CITY_VOX.z1); this.mesher.rebuild(this.grid); this.seedMeshChunks();
      this.heightField.rebuild(this.grid);
      this.streamColliders(true);      // …then re-stream only the ones near the player
      this.dirtyChunks.clear();
      this.dirtyCol.clear();
      this.rebuildAllColliders = false;
      return;
    }
    // Rebuilds are TIME-budgeted so they never stack into a visible hitch — a chunk rebuild can be
    // several ms, so 4 of them was a ~20ms jolt. Spread across frames instead.
    const _rt0 = performance.now();
    // Under load the governor shrinks the per-frame rebuild budget so a carving spree spreads the
    // chunk rebuilds over MORE frames (lower peak) instead of stacking into a hitch — the biggest
    // measured cost during "many shots". Full budget with headroom, ~half when the governor is floored.
    const s = this.governor.budgetScale;
    const meshBudget = 2.5 + 2.5 * s;   // 2.5..5 ms
    // Meshes (visual): keep the chunk NEAREST the player (the carve site they're looking at) SYNCHRONOUS
    // so its geometry updates the SAME frame — no visible lag where it matters. Distant dirty chunks cook
    // OFF-THREAD (their 1-2 frame delay is imperceptible and masked by the carve FX). markChunkKey re-adds
    // + bumps gen if a chunk changes again; onMeshCooked applies the async ones when they return.
    if (this.dirtyChunks.size > 0) {
      // Every dirty RENDER chunk cooks OFF-THREAD now. A 64³ mesh chunk is 8× the voxels of the old 32³,
      // so cooking even the focus chunk synchronously would be a visible carve hitch — and the user's floor
      // is "never below 60". The blast's muzzle flash + debris burst fire the SAME frame, so the ~1-frame
      // async lag on the hole itself is imperceptible. (In node/tests with no worker, requestMesh cooks
      // inline via the sync fallback, so behaviour there is unchanged.)
      for (const ck of this.dirtyChunks) {
        const [cx, cy, cz] = unpackKey(ck);
        this.dirtyChunks.delete(ck);
        // Only re-cook chunks that are CURRENTLY built (in the render bubble). A carve far from the player
        // updates the grid but not a mesh that doesn't exist — streamMeshes rebuilds it fresh from the grid
        // when the player returns (mirrors the collider dirty logic). Its universe already knows the chunk.
        this.meshChunks.add(ck);
        if (!this.mesher.hasChunk(ck)) continue;
        const keys = this.grid.meshChunkVoxelKeys(cx, cy, cz);
        const matIdx = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) matIdx[i] = this.grid.materialIndexAt(keys[i]);
        this.cookService.requestMesh(ck, Int32Array.from(keys), matIdx);
        if (performance.now() - _rt0 > meshBudget) break;
      }
    }
    // Rebuilding a chunk collider forces Rapier to re-optimise the static broadphase on the NEXT
    // world.step, and doing SEVERAL in one frame is SUPERLINEAR (measured: 1 chunk ≈ no churn, 4 ≈
    // +14 ms in the next step, 8 ≈ +25 ms). So rebuild AT MOST ONE collider chunk per frame, and pick
    // the one NEAREST the player: building colliders exist ONLY for the local player's movement
    // (bullets raycast the grid with EXCLUDE_FIXED, debris are in a separate group), so a wall carved
    // far away can wait its turn without any visible effect. This is the dominant cost during combat.
    if (this.dirtyCol.size > 0) {
      const COL_DELAY = 0.3;
      const pp = this.player.camera.position;
      const [pvx, pvy, pvz] = VoxelGrid.worldToVoxel(pp.x, pp.y, pp.z);
      const pcx = chunkCoord(pvx), pcy = chunkCoord(pvy), pcz = chunkCoord(pvz);
      let bestKey = -1, bestDist = Infinity;
      for (const [ck, t] of this.dirtyCol) {
        if (this.time - t < COL_DELAY) continue; // still being carved → let it settle first
        const [cx, cy, cz] = unpackKey(ck);
        // out of the LOD set → drop it; streamColliders rebuilds it fresh from the grid on return
        if (!this.collider.hasChunk(cx, cy, cz)) { this.dirtyCol.delete(ck); continue; }
        const d = Math.abs(cx - pcx) + Math.abs(cy - pcy) + Math.abs(cz - pcz);
        if (d < bestDist) { bestDist = d; bestKey = ck; }
      }
      if (bestKey >= 0) {
        const [cx, cy, cz] = unpackKey(bestKey);
        // Snapshot the chunk's voxels and cook OFF-THREAD (or inline via the sync fallback). Taken off the
        // dirty set now; a later carve re-adds it via markChunkKey (which also bumps gen → any stale
        // in-flight result is dropped). onColliderCooked applies the boxes when they return.
        this.dirtyCol.delete(bestKey);
        this.cookService.requestCollider(bestKey, Int32Array.from(this.grid.chunkVoxelKeys(cx, cy, cz)));
      }
    }
  }

  private syncProps(): void {
    for (const p of this.props) {
      // Skip asleep props (parked cars, crates, gas tanks — the majority). Rapier's translation()/rotation()
      // each ALLOCATE a {x,y,z} object, so re-syncing every resting prop every frame was a top GC source while
      // flying (perf.log proved the residual tirón is GC: all phases low + heap drops on the spike frames). A
      // sleeping body hasn't moved since we last synced it, so its mesh is already correct; isSleeping() is a
      // cheap bool with no allocation. When it's hit and wakes, it syncs again.
      if (p.body.isSleeping()) continue;
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  private updateFlashes(dt: number): void {
    for (const f of this.flashes) {
      if (f.life <= 0) { if (f.light.intensity !== 0) f.light.intensity = 0; continue; }
      f.life -= dt;
      f.light.intensity = f.life > 0 ? f.intensity * (f.life / f.max) : 0;
    }
  }
}
