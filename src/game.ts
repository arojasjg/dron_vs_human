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
import { Renderer } from "./engine/renderer";
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
import { BIG, ammoBoxSites, buildBuilding, buildCar, buildDefaultScene, buildHouse, buildObjectives, buildTower, buildWall, groundClass, objectiveHp, objectiveDestroyed, OBJECTIVE_SITES, placedBuildings, setWorldSeed } from "./build/prefabs";
import { InteriorLights } from "./engine/interiorLights";
import { Hud, type Mode, type Tool } from "./ui/hud";
import { CameraFx } from "./fx/cameraFx";
import { addTrauma, decayTrauma, shakeOffset } from "./engine/cameraFeel";
import { GameAudio } from "./fx/audio";
import { Scenery } from "./fx/scenery";
import { AmmoCrates } from "./fx/ammoCrates";
import { Net, type NetMsg } from "./net/net";
import { RemoteDrones, MAX_HP } from "./net/remoteDrones";
import { assignRole, roleMaxHp, roleWeapon, type Role } from "./net/roles";
import { makeRoomCode, emptyLobby, applyJoin, applyLeave, applyPick, hostOf, type LobbyState } from "./net/lobby";
import { AiSwarm, type AiTarget } from "./net/ai";
import { WEAPONS, roleLoadout, tryFire, fullAmmo, batteryDrain, BATTERY_MAX, rayHitsSphere, meleeHit, bulletFalloff, type Weapon, type Ammo } from "./net/weapons";
import { checkWin, reconcileKills, baseAlert, type MatchState } from "./net/objectives";
import { MATERIAL_ORDER, MATERIALS, type MaterialId } from "./world/materials";
import { packKey, unpackKey, VoxelGrid, type RayHit } from "./world/voxelGrid";
import { chunkCoord, VoxelCollider } from "./world/voxelCollider";
import { MESH_CHUNK, MESH_CHUNK_RATIO } from "./world/cook";
import { VoxelMesher } from "./world/voxelMesh";
import { connectedComponents, type Voxel } from "./world/structuralIntegrity";

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
  private gasTanks: { vox: Voxel[]; cx: number; cy: number; cz: number; live: boolean }[] = [];
  private readonly tankChain: { cx: number; cy: number; cz: number; delay: number }[] = [];

  private tool: Tool = "shoot";
  private matIndex = 1; // concrete
  private brush = 0;
  // weapon reload: a tool can't fire again until game time passes its readyAt
  private grenadeReadyAt = 0;
  private missileReadyAt = 0;
  // --- team combat (vs/dvh): per-team weapon loadout, ammo, drone battery ---
  private weapon: Weapon = "mg";
  private readonly ammo: Record<Weapon, Ammo> = {
    mg: fullAmmo(WEAPONS.mg), grenade: fullAmmo(WEAPONS.grenade), kamikaze: fullAmmo(WEAPONS.kamikaze),
    shotgun: fullAmmo(WEAPONS.shotgun), glauncher: fullAmmo(WEAPONS.glauncher), net: fullAmmo(WEAPONS.net),
  };
  private weaponReadyAt = 0;      // shared per-shot cooldown gate
  private firing = false;         // LMB held → auto-fire (machine gun) each frame at the weapon's rate
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

  // Four spread spawn points across the ground-floor lobby (the 4 quadrants), clear of the NW
  // stairwell and the NE gas tank. Players are assigned one by their network id. World coords.
  private static readonly SPAWNS: [number, number, number][] = [
    [40 * VOXEL, 2.0, 40 * VOXEL],   // SW
    [248 * VOXEL, 2.0, 40 * VOXEL],  // SE
    [40 * VOXEL, 2.0, 176 * VOXEL],  // NW (east of the stairwell)
    [248 * VOXEL, 2.0, 176 * VOXEL], // NE (west of the gas tank)
  ];

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
  private hosting = false;              // we created the room → we are the AI authority in co-op
  private swarm: AiSwarm | null = null; // host-only enemy AI simulation
  private aiBcast = 0;                  // seconds until the next bot-transform broadcast
  private aiWaveGap = 0;                // countdown to the next wave once the swarm is cleared
  private readonly aiBots = new Map<number, { x: number; y: number; z: number }>(); // last-known bot positions (for shooting them)
  private quality: Quality = "medio";     // graphics preset (Bajo/Medio/Alto), K to cycle
  private role: Role = "drone";           // Drones-vs-Humans: our team
  private droneKills = 0;
  private humanKills = 0;
  private matchOver = false;
  private prevDroneHp = 1;   // weakest drone-base HP last frame → base-under-attack threshold alerts
  private prevHumanHp = 1;
  private static readonly KILL_LIMIT = 15; // deathmatch limit (win also by destroying the enemy objective)
  private hp = MAX_HP;
  private netT = 0;          // throttle for state broadcasts
  private netSent = 0;       // diagnostic: count of state messages sent
  private lastState: NetMsg | null = null; // last state sent — re-emitted by the background heartbeat
  private respawnAt = 0;     // when dead, time to respawn
  private spawnIndex = 0;    // which of the 4 spawn points this player uses (by network id)

  private readonly tmpDir = new THREE.Vector3();
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
      (x, y, z, r, p) => this.explodeAt(x, y, z, r, p, true), // local weapon detonation → broadcast
      (hit, dx, dy, dz) => this.onBulletHit(hit, dx, dy, dz),
    );

    this.buildGround();
    this.scenery = new Scenery(this.renderer.scene); // trees + clouds
    this.ammoCrates = new AmmoCrates(this.renderer.scene); // soldier ammo pickups (populated per world)
    this.initFlashes();
    buildDefaultScene(this.grid);
    this.mesher.rebuild(this.grid); this.seedMeshChunks();
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

    this.input.onMouseDown = (b) => this.onMouseDown(b);
    this.input.onMouseUp = (b) => { if (b === 0) this.firing = false; }; // release LMB → stop auto-fire
    this.input.onWheel = (s) => this.onWheel(s);
    this.input.onKey = (c) => this.onKey(c);

    this.remotes = new RemoteDrones(this.renderer.scene);
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
    });
    this.refreshLobby();
  }

  /** Re-announce our presence (id, chosen role, mode) so the roster converges on every client. */
  private broadcastLobby(): void {
    this.lobby = applyJoin(this.lobby, this.net.id, this.myRole);
    if (this.net.connected) this.net.send({ t: "lobby", role: this.myRole, mode: this.pendingMode });
    this.refreshLobby();
  }

  private lobbyPick(role: Role): void {
    this.myRole = role;
    this.lobby = applyPick(this.lobby, this.net.id, role);
    this.broadcastLobby();
  }

  private hostStart(): void {
    if (this.net.id !== (hostOf(this.lobby) ?? this.net.id)) return; // only the host may start
    this.net.send({ t: "begin", mode: this.pendingMode });
    this.beginMatch();
  }

  private refreshLobby(): void {
    if (this.phase !== "lobby") return;
    const host = hostOf(this.lobby) ?? this.net.id;
    this.hud.updateLobby(this.lobby.players.map((p) => ({ id: p.id, role: p.role })), this.net.id, host, this.myRole);
  }

  /** Everyone runs this on the host's "begin": build the shared seed-world + spawn with the chosen role. */
  private beginMatch(): void {
    if (this.phase === "playing") return;
    this.mode = this.pendingMode;
    this.rebuildWorld(hashStr(this.roomCode), false);
    this.phase = "playing";
    this.hud.hideLobby();
    this.hud.setMode(this.mode, this.roomCode);
    this.applyChosenRole(this.mode === "coop" ? "human" : (this.myRole ?? "human"));
    this.spawnPlayerInBuilding();
    this.net.send({ t: "needsync" });
    if (this.mode === "coop" && this.hosting) { this.swarm = new AiSwarm(); this.aiWaveGap = 0; } // host owns the enemy AI
    this.audio.ui();
  }

  // --- enemy AI (co-op) ----------------------------------------------------

  /** Per-frame AI. The HOST simulates the swarm (spawn waves, seek, fire), broadcasts bot transforms and
   *  renders them; peers only render from the broadcast. Bots target the host soldier (peer-targeting later). */
  private aiFrame(dt: number): void {
    if (this.mode !== "coop") return;
    const s = this.swarm;
    if (this.hosting && s) {
      const cp = this.player.camera.position;
      if (s.count === 0) {
        this.aiWaveGap -= dt;
        if (this.aiWaveGap <= 0) { s.spawnWave(cp.x, cp.z, 55, cp.y + 12); this.hud.flash(`⚠ Oleada ${s.wave}: ${s.count} drones`); }
      } else this.aiWaveGap = 4;
      const targets: AiTarget[] = this.hp > 0 ? [{ id: this.net.id, x: cp.x, y: cp.y, z: cp.z }] : [];
      for (const f of s.tick(dt, targets)) this.aiShoot(f.x, f.y, f.z, f.dx, f.dy, f.dz, f.targetId);
      this.aiBots.clear();
      for (const b of s.list) this.aiBots.set(b.id, { x: b.x, y: b.y, z: b.z });
      this.aiBcast -= dt;
      if (this.aiBcast <= 0 && this.net.connected) {
        this.aiBcast = 0.07;
        this.net.send({ t: "ai", b: s.list.map((b) => [b.id, +b.x.toFixed(2), +b.y.toFixed(2), +b.z.toFixed(2)]) });
      }
    }
    this.renderBots();
  }

  /** Draws every known bot as a remote drone avatar under a synthetic NEGATIVE id (never collides with peers). */
  private renderBots(): void {
    for (const [id, p] of this.aiBots) this.remotes.upsert(-id, p.x, p.y, p.z, 0, 0, 0, 1, 100, "drone", 100, 0, 0, 0);
  }

  /** A bot fires: muzzle flash (broadcast so all see it) + host-authoritative chip damage to its target
   *  (dodgeable — break line of sight to avoid the next shot). */
  private aiShoot(x: number, y: number, z: number, dx: number, dy: number, dz: number, targetId: number): void {
    this.muzzleFlash(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz), 0.3);
    if (this.net.connected) this.net.send({ t: "aifire", x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1), dx: +dx.toFixed(2), dy: +dy.toFixed(2), dz: +dz.toFixed(2) });
    if (targetId === this.net.id) { if (this.hp > 0 && Math.random() < 0.55) this.damageDrone(4); }
    else if (this.net.connected) this.net.send({ t: "aihit", to: targetId, dmg: 4 });
  }

  /** When the local player shoots, test the aim ray against known bot positions and damage the nearest hit. */
  private aiHitscan(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    if (this.mode !== "coop" || this.aiBots.size === 0) return;
    let hitId = -1, hitT = 30;
    for (const [id, p] of this.aiBots) {
      const wx = p.x - ox, wy = p.y - oy, wz = p.z - oz;
      const t = wx * dx + wy * dy + wz * dz;                 // projection of the bot onto the ray
      if (t < 0 || t > hitT) continue;
      const cx = ox + dx * t - p.x, cy = oy + dy * t - p.y, cz = oz + dz * t - p.z;
      if (cx * cx + cy * cy + cz * cz < 1.4) { hitId = id; hitT = t; } // within ~1.2 m of the line
    }
    if (hitId < 0) return;
    this.hud.hitMarker("hit"); this.audio.hitMarker(false);
    if (this.hosting && this.swarm) { if (this.swarm.damageBot(hitId, 1)) this.onBotDead(hitId); }
    else if (this.net.connected) this.net.send({ t: "aihitbot", bot: hitId });
  }

  /** A bot died (host authority): drop its avatar everywhere, credit the shooter. */
  private onBotDead(id: number): void {
    this.aiBots.delete(id);
    this.remotes.remove(-id);
    this.myKills++;
    this.hud.hitMarker("kill");
    if (this.net.connected) this.net.send({ t: "aidead", bot: id });
  }

  private onNet(m: NetMsg): void {
    if (m.t === "hello") {
      // got our network id → take the matching spawn point so players start apart
      this.spawnIndex = (this.net.id - 1) % Game.SPAWNS.length;
      if (this.phase === "lobby") { this.broadcastLobby(); return; } // announce self; wait for the host to begin
      if (this.mode === "dvh" || this.mode === "vs" || this.mode === "coop") this.assignRoleAndController();
      this.spawnPlayerInBuilding();
      // We may have joined AFTER destruction happened. Our world is pristine (seed-built) → ask any peer
      // that already has destruction to send us its diff, so our grid matches theirs (fixes the desync
      // where a late joiner sees a building standing that everyone else already collapsed).
      this.net.send({ t: "needsync" });
    } else if (m.t === "lobby") {
      if (this.phase !== "lobby") return;
      this.lobby = m.role ? applyPick(this.lobby, m.id as number, m.role as Role) : applyJoin(this.lobby, m.id as number);
      if (m.mode && this.pendingMode !== m.mode) { // joiner learned the room's mode from the host
        this.pendingMode = m.mode as Mode;
        if (m.mode === "coop") this.myRole = "human"; // co-op: everyone's a soldier
        this.showLobbyUi();
      }
      this.refreshLobby();
    } else if (m.t === "begin") {
      if (this.phase === "lobby") { if (m.mode) this.pendingMode = m.mode as Mode; this.beginMatch(); }
    } else if (m.t === "ai") {
      if (this.mode === "coop" && !this.hosting) { // peers render the host's swarm from its broadcast
        this.aiBots.clear();
        for (const row of m.b as number[][]) this.aiBots.set(row[0], { x: row[1], y: row[2], z: row[3] });
      }
    } else if (m.t === "aifire") {
      this.muzzleFlash(new THREE.Vector3(m.x as number, m.y as number, m.z as number), new THREE.Vector3(m.dx as number, m.dy as number, m.dz as number), 0.3);
    } else if (m.t === "aihit") {
      if ((m.to as number) === this.net.id && this.hp > 0) this.damageDrone(m.dmg as number); // host said a bot hit me
    } else if (m.t === "aihitbot") {
      if (this.hosting && this.swarm && this.swarm.damageBot(m.bot as number, 1)) this.onBotDead(m.bot as number); // a peer shot a bot
    } else if (m.t === "aidead") {
      this.aiBots.delete(m.bot as number); this.remotes.remove(-(m.bot as number));
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
        (m.ry as number) || 0, (m.rp as number) || 0, ((m.st as number) || 0) as 0 | 1 | 2);
      if (this.mode === "dvh" && typeof m.dk === "number") {
        const merged = reconcileKills({ drone: this.droneKills, human: this.humanKills }, { drone: m.dk as number, human: m.hk as number });
        this.droneKills = merged.drone; this.humanKills = merged.human;
        this.checkMatchWin();
      }
    } else if (m.t === "weapon") {
      this.fireRemoteWeapon(m);
    } else if (m.t === "explode") {
      this.explodeAt(m.x as number, m.y as number, m.z as number, m.r as number, m.p as number, false, m.id as number);
    } else if (m.t === "ammo") {
      this.ammoCrates.take(m.i as number, this.time); // a peer grabbed a crate → hide it here too
    } else if (m.t === "hit") {
      this.applyBulletHit(
        m.vx as number, m.vy as number, m.vz as number, m.dx as number, m.dy as number, m.dz as number,
        m.px as number, m.py as number, m.pz as number, m.nx as number, m.ny as number, m.nz as number,
      );
    } else if (m.t === "died") {
      if (this.mode === "dvh") this.addKill(m.role as Role); // a peer died → the enemy team scores (PvP only)
      const by = m.by as number, mine = by === this.net.id;
      const victim = (m.role as Role) === "human" ? "🧍" : "🤖";
      const killer = mine ? "Tú" : by ? `J${by % 1000}` : ""; // no name layer → short id label
      this.hud.killfeed(killer ? `${killer} ☠ ${victim}` : `${victim} caído`, mine);
      if (mine) { this.myKills++; this.hud.flash("¡Derribo!"); this.hud.hitMarker("kill"); this.audio.hitMarker(true); }
      else if (Array.isArray(m.assist) && (m.assist as number[]).includes(this.net.id)) this.myAssists++;
    } else if (m.t === "melee") {
      this.remotes.meleeAnim(m.id as number); // swing on the attacker's avatar
      const p = this.player.camera.position;
      if (this.hp > 0 && meleeHit(m.ox as number, m.oy as number, m.oz as number, m.dx as number, m.dy as number, m.dz as number, p.x, p.y, p.z, m.range as number, 0.5)) {
        this.recordDamager(m.id as number); this.damageDrone(m.dmg as number); this.audio.meleeHit();
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
    this.applyChosenRole(this.mode === "coop" ? "human" : assignRole([], this.net.id));
  }

  /** Applies a role: swaps the local controller (Walker human / flying drone Player), sets HP/weapon/camera. */
  private applyChosenRole(role: Role): void {
    this.role = role;
    const wantWalker = role === "human";
    if (wantWalker !== (this.player instanceof Walker)) {
      this.player.dispose();
      this.player = wantWalker ? new Walker(this.physics, this.grid) : new Player(this.physics);
    }
    this.hp = this.myMaxHp(); // humans spawn tankier than drones
    this.weapon = roleLoadout(this.role)[0]; // start on the team's primary weapon
    this.resupply();
    this.camFx.setRole(this.role); // FPV for drones, body-cam for humans
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
  }

  /** Local max HP: role-based in any versus mode (human tank, drone fragile), else the default. */
  private myMaxHp(): number { return this.mode === "dvh" || this.mode === "vs" || this.mode === "coop" ? roleMaxHp(this.role) : MAX_HP; }

  /** Scores a kill for the team opposing the victim, then checks for a match win. */
  private addKill(victim: Role): void {
    if (victim === "human") this.droneKills++; else this.humanKills++;
    this.checkMatchWin();
  }

  /** DvH win check: destroy the enemy objective or hit the kill limit. Objectives live in the
   *  synced grid, so every client reaches the same verdict. */
  private checkMatchWin(): void {
    if (this.mode !== "dvh" || this.matchOver || OBJECTIVE_SITES.length < 4) return;
    const mat = (x: number, y: number, z: number) => this.grid.get(x, y, z);
    // count each team's SURVIVING bases (destroyed = ~75% of its metal razed) + weakest-base HP for the HUD
    let droneObjsAlive = 0, humanObjsAlive = 0, droneHp = 1, humanHp = 1;
    for (const s of OBJECTIVE_SITES) {
      const hp = objectiveHp(s, mat);
      if (s.team === "drone") { if (!objectiveDestroyed(s, mat)) droneObjsAlive++; droneHp = Math.min(droneHp, hp); }
      else { if (!objectiveDestroyed(s, mat)) humanObjsAlive++; humanHp = Math.min(humanHp, hp); }
    }
    this.hud.setScore(this.droneKills, this.humanKills, droneObjsAlive, humanObjsAlive, droneHp, humanHp);
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
    const state: MatchState = { droneObjsAlive, humanObjsAlive, droneKills: this.droneKills, humanKills: this.humanKills };
    const winner = checkWin(state, Game.KILL_LIMIT);
    if (winner) { this.matchOver = true; this.hud.showWin(winner, this.role); }
  }

  /** Spawns a GHOST of a weapon a remote player fired — it flies for the visuals but never mutates
   *  the grid; the authoritative `explode`/`hit` message from that player does the actual damage. */
  private fireRemoteWeapon(m: NetMsg): void {
    const o = new THREE.Vector3(m.ox as number, m.oy as number, m.oz as number);
    const d = new THREE.Vector3(m.dx as number, m.dy as number, m.dz as number);
    if (m.k === "bullet") {
      this.projectiles.launchBullet(o, d, 120, true);
      this.muzzleFlash(o, d, 0.34); // enemy gunfire is visible/spottable at range
      const base = (m.dmg as number) || 0; // a bullet in our line of fire hurts us (any team — "a todos")
      if (base > 0 && this.hp > 0 && this.bulletHitsMe(o, d)) {
        const p = this.player.camera.position;
        const dmg = base * bulletFalloff((m.w as string) || "", Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z));
        this.recordDamager(m.id as number); this.damageDrone(Math.round(dmg)); // range-scaled (shotgun close = lethal, far = weak)
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
    this.remotes.enemyPositions(this.role === "human", this.mode === "free" || this.mode === "coop", this.enemyBuf);
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
    // respawn works in every mode, even offline (blasts/debris can kill you in the sandbox too)
    if (this.hp <= 0 && this.time >= this.respawnAt) {
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
      dk: this.droneKills, hk: this.humanKills, // scoreboard → max-merged by peers (self-healing)
    };
    this.net.send(this.lastState);
  }

  /** Applies damage to our own drone (blasts + fast debris, in every mode) — computed locally on
   *  each client and broadcast via the periodic state message, so health stays consistent. */
  private damageDrone(amount: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.trauma = addTrauma(this.trauma, Math.min(0.6, amount / 60)); // taking a hit jolts the view + flashes the HUD
    this.hud.damageFlash(Math.min(1, amount / 50));
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
    if (this.hp > 0) this.audio.hit(); else this.audio.death(this.role === "human"); // drones crash, not grunt
    if (this.hp <= 0) {
      this.respawnAt = this.time + 3;
      this.hud.flash("Derribado — reapareces en 3s");
      this.myDeaths++;
      if (this.mode !== "free") {
        // Attribute the kill: the most-recent damager (last ~6 s) is the killer; earlier ones assist.
        let killer = 0, killerT = -1; const assist: number[] = [];
        for (const [id, t] of this.damagers) {
          if (this.time - t > 6) continue;
          if (t > killerT) { if (killer) assist.push(killer); killer = id; killerT = t; } else assist.push(id);
        }
        this.damagers.clear();
        this.net.send({ t: "died", role: this.role, by: killer, assist }); // peers score + credit the killer
        if (this.mode === "dvh") this.addKill(this.role);                   // team score (relay doesn't echo)
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
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
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
      this.audio.setRotor(this.mode === "free" || this.hp > 0 ? 1 : 0, this.player.speed(), 0.032); // your own rotor: quiet
    } else {
      const w = this.player;
      // a human on the ground HEARS enemy drones — the closer one gets, the louder its rotor
      const p = w.camera.position;
      const dist = this.remotes.nearestDroneDist(p.x, p.y, p.z);
      const AUD = 50; // metres of audibility
      this.audio.setRotor(dist < AUD ? Math.min(1, 1 - dist / AUD) : 0, 30, 0.14);
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
    this.mesher.rebuild(this.grid); this.seedMeshChunks();
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
    // grassy terrain: a big subdivided plane — flat under the city, gently rolling beyond it, and
    // mottled with muted greens so it reads as grass/ground without a texture. Purely visual; the
    // physics floor above stays a flat slab, and the displacement never rises under the buildings.
    // Higher SEG so the 3.5 m streets resolve. Flat under the city, rolling hills only well beyond it.
    const SEG = 160, SIZE = 400;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x3f4a2e), asphalt = new THREE.Color(0x2b2d31), concrete = new THREE.Color(0x6b675e), tint = new THREE.Color();
    const noise = (x: number, z: number) => Math.sin(x * 0.05) * Math.cos(z * 0.045) + 0.5 * Math.sin(x * 0.12 + z * 0.1);
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = -pos.getY(i);                                  // plane local → world XZ
      const cls = groundClass(wx / VOXEL, wz / VOXEL);                            // street / plot / outside
      const edge = cls === "outside" ? Math.max(0, Math.abs(wx) - 95, Math.abs(wz) - 80) : 0;
      pos.setZ(i, Math.min(edge / 60, 1) * 4 * noise(wx, wz));                    // rolling hills only outside the city
      const n = 0.5 + 0.5 * noise(wx * 1.7, wz * 1.7);
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
    setWorldSeed(seed);
    this.worldSeed = seed >>> 0; // same seed drives world gen AND every per-event destruction RNG
    for (const p of this.props) { this.physics.world.removeRigidBody(p.body); this.renderer.scene.remove(p.mesh); }
    this.props.length = 0;
    this.grid.clear();
    buildDefaultScene(this.grid);
    if (this.mode === "dvh") {
      buildObjectives(this.grid); // a destructible core per team
      this.droneKills = 0; this.humanKills = 0; this.matchOver = false; this.hud.hideWin();
    }
    (this.interiorLights ??= new InteriorLights(this.renderer.scene)).build(placedBuildings(), this.interiorLightBudget());
    this.ensureFlashlight(); // pre-create at intensity 0 so the first F toggle causes no light-count recompile
    this.mesher.rebuild(this.grid); this.seedMeshChunks();
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
    if (withProps) this.spawnInitialProps();
    this.spawnPlayerInBuilding();
  }

  /** Drops the player at its assigned spawn point, facing the building centre. */
  private spawnPlayerInBuilding(): void {
    const [x, y, z] = Game.SPAWNS[this.spawnIndex % Game.SPAWNS.length];
    this.player.spawn(x, y, z, Math.atan2(36 - x, 27 - z)); // face the lobby centre (≈36,27)
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
    const [pvx, pvy, pvz] = VoxelGrid.worldToVoxel(p.x, p.y, p.z);
    const pcx = chunkCoord(pvx), pcy = chunkCoord(pvy), pcz = chunkCoord(pvz);
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
      const [cx, cy, cz] = unpackKey(ck);
      if (Math.abs(cx - pcx) > far || Math.abs(cy - pcy) > far || Math.abs(cz - pcz) > far) drop.push(ck);
    }
    for (const ck of drop) {
      const [cx, cy, cz] = unpackKey(ck);
      this.collider.removeChunk(cx, cy, cz);
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
      const [mcx, mcy, mcz] = unpackKey(ck);
      const dx = mcx * MESH_CHUNK * VOXEL + HALF - p.x, dz = mcz * MESH_CHUNK * VOXEL + HALF - p.z;
      if (dx * dx + dz * dz > R2) continue;
      const keys = this.grid.meshChunkVoxelKeys(mcx, mcy, mcz);
      if (keys.length === 0) continue;                     // chunk carved to nothing → nothing to build
      const matIdx = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) matIdx[i] = MATERIAL_ORDER.indexOf(this.grid.materialAt(keys[i])!);
      this.meshInFlight.add(ck);
      this.cookService.requestMesh(ck, Int32Array.from(keys), matIdx);
      if (++built >= 3) break;                             // budget: ≤3 requests/frame so a fast crossing never stalls
    }
    // DISPOSE far built chunks (collect then remove — don't mutate the Map mid-iteration). Budget the drop so
    // the one-time post-load trim (everything built → bubble) spreads over frames instead of a dispose hitch.
    const drop = this._meshDrop; drop.length = 0;
    for (const ck of this.mesher.builtChunks()) {
      const [mcx, , mcz] = unpackKey(ck);
      const dx = mcx * MESH_CHUNK * VOXEL + HALF - p.x, dz = mcz * MESH_CHUNK * VOXEL + HALF - p.z;
      if (dx * dx + dz * dz > dropR2) { drop.push(ck); if (drop.length >= 12) break; }
    }
    for (const ck of drop) this.mesher.disposeChunk(ck);
  }

  private explodeAt(x: number, y: number, z: number, radius: number, power: number, broadcast = false, by = 0): void {
    // Quantize to the wire precision AT SOURCE, so this client carves with the EXACT numbers every peer
    // receives — otherwise a <1cm float mismatch flips crater-edge voxels (the lobe test at carve.ts is a
    // hard cutoff) and the per-event RNG seed diverges. Math.round (not toFixed → stable on negatives).
    x = q2(x) / 100; y = q2(y) / 100; z = q2(z) / 100; radius = q2(radius) / 100;
    const seed = eventSeed(this.worldSeed, EVT.EXPLODE, q2(x), q2(y), q2(z), q2(radius), power | 0);
    // A player-initiated blast is authoritative: broadcast its (already quantized) position so EVERY
    // client carves identically. Cascades (gas chains, collapse) are deterministic on the synced grid,
    // so they run locally on each client and are NOT broadcast (broadcast stays false for those calls).
    if (broadcast && this.net.connected) {
      this.net.send({ t: "explode", x, y, z, r: radius, p: power });
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
      if (dist < dr) { this.recordDamager(by); this.damageDrone(Math.round((1 - dist / dr) * 55)); }
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
      return { vox, cx: Math.round(sx / n), cy: Math.round(sy / n), cz: Math.round(sz / n), live: true };
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
    this.addFlash(x, y, z, radius);
    this.sink.burst(x, y, z, {
      count: 2, color: 0xffd27a, speed: 3, size: 2, life: 0.07,
      buoyancy: 0, windCoupling: 0.05, kind: "spark", strength: 0.004,
    });
  }

  // --- input -------------------------------------------------------------

  private onMouseDown(button: number): void {
    if (button === 0) this.firing = true; // hold LMB → keep firing (see autoFire in the frame loop)
    if (this.hp <= 0) return; // dead → wait for respawn
    const origin = this.player.camera.position;
    const dir = this.player.forward(this.tmpDir).clone();

    // Combat modes (vs/dvh) use the per-team weapon loadout + ammo, not the sandbox tools.
    if (this.mode !== "free") { this.fireWeapon(origin, dir); return; }

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
    if (this.mode !== "free") { this.fireWeapon(origin, dir); return; } // cooldown-gated → full-auto
    if (this.tool === "shoot" && this.time >= this.bulletReadyAt) {
      this.bulletReadyAt = this.time + 0.09; // ~11 rounds/sec
      this.shoot(origin, dir);
      this.audio.shot("mg");
    }
  }

  private applyEdit(region: EditRegion | null): void {
    if (region) this.markRegion(region[0], region[1], region[2], region[3], region[4], region[5]);
  }

  private shoot(origin: THREE.Vector3, dir: THREE.Vector3, dmg = 0): void {
    this.projectiles.launchBullet(origin, dir);
    this.aiHitscan(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z); // damage co-op AI drones on the shot line
    this.muzzleFlash(origin, dir, 0.22); // subtle first-person muzzle glow (pool keeps one alive during auto-fire)
    this.trauma = addTrauma(this.trauma, 0.03); // light per-shot kick
    if (dmg > 0) this.predictHit(origin, dir); // local hit marker when our round is on an enemy
    this.broadcastWeapon("bullet", origin, dir, dmg);
  }

  /** Tells the other players we fired, so they see the projectile; `dmg` lets a bullet hurt whoever's
   *  in its line of fire (each hit peer self-applies the damage — the same model as blasts). */
  private broadcastWeapon(k: string, o: THREE.Vector3, d: THREE.Vector3, dmg = 0): void {
    if (!this.net.connected) return;
    this.net.send({
      t: "weapon", k, dmg, w: this.weapon, // w = weapon id, so the victim can apply range falloff
      ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
      dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3),
    });
  }

  /** Fire the active team weapon (vs/dvh): cooldown + ammo gates, then dispatch by fire kind. */
  private fireWeapon(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const spec = WEAPONS[this.weapon];
    if (this.time < this.weaponReadyAt) return;
    const res = tryFire(this.ammo[this.weapon], spec.magSize);
    if (!res.fired) { this.hud.flash("Sin munición — recarga en tu base"); this.audio.emptyClick(); return; }
    this.ammo[this.weapon] = res.ammo;
    this.weaponReadyAt = this.time + spec.cooldown;
    const w = roleWeapon(this.role);
    switch (spec.fire) {
      case "bullet":    this.shoot(origin, dir, spec.playerDmg ?? 0); break;
      case "shotgun":   this.fireShotgun(origin, dir, spec.pellets ?? 8, spec.playerDmg ?? 0); break;
      case "grenade":   this.projectiles.launchGrenade(origin.clone(), dir, 22, false, w.powerMul); this.broadcastWeapon("grenade", origin, dir); break;
      case "explosive": this.projectiles.launchRocket(origin.clone(), dir, 52, false, w.powerMul); this.broadcastWeapon("missile", origin, dir); break;
      case "net":       this.fireNet(origin, dir); break;
      case "kamikaze":  this.kamikaze(origin); break;
    }
    this.audio.shot(this.weapon); // muzzle report for the fired weapon
    this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon]);
  }

  /** Shotgun: a tight bullet spread. Each pellet's grid hit is broadcast, so peers stay in sync. */
  private fireShotgun(origin: THREE.Vector3, dir: THREE.Vector3, pellets: number, dmg: number): void {
    // Seeded spread (was Math.random) so every pellet is lockstep-reproducible; each pellet's grid hit
    // is still broadcast as a `hit` for grid convergence, but the pattern itself is now deterministic.
    const rng = new Rng(eventSeed(this.worldSeed, EVT.SHOTGUN, q2(origin.x), q2(origin.y), q2(origin.z), q3(dir.x), q3(dir.y), q3(dir.z)));
    for (let i = 0; i < pellets; i++) {
      const d = new THREE.Vector3(
        dir.x + rng.centered(0.09),
        dir.y + rng.centered(0.09),
        dir.z + rng.centered(0.09),
      ).normalize();
      this.projectiles.launchBullet(origin, d);
    }
    this.muzzleFlash(origin, dir, 0.34); // bigger pop for the shotgun
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
        t: "melee", dmg: 55, range: 2.4,
        ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
        dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3),
      });
    }
  }

  private selectWeapon(w: Weapon): void {
    this.weapon = w;
    this.audio.weaponSwitch();
    this.hud.setWeapon(this.role, w, this.ammo[w]);
    this.hud.flash(`${WEAPONS[w].icon} ${WEAPONS[w].name}`);
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
  private nearOwnBase(): boolean {
    const p = this.player.camera.position;
    for (const site of OBJECTIVE_SITES) {
      if (site.team !== this.role) continue;
      const cx = (site.x0 + site.x1) * 0.5 * VOXEL, cy = (site.y0 + site.y1) * 0.5 * VOXEL, cz = (site.z0 + site.z1) * 0.5 * VOXEL;
      if (Math.hypot(p.x - cx, p.y - cy, p.z - cz) < 8) return true;
    }
    return false;
  }

  /** Refill this role's weapon ammo (full mag + full reserve) — the part a supply crate gives. Returns
   *  whether anything was below full, so a crate isn't wasted on an already-stocked soldier. NO battery. */
  private resupplyAmmo(): boolean {
    let gained = false;
    for (const w of roleLoadout(this.role)) {
      const spec = WEAPONS[w], cur = this.ammo[w];
      if (cur.mag < spec.magSize || cur.reserve < spec.maxReserve) gained = true;
      this.ammo[w] = fullAmmo(spec);
    }
    return gained;
  }

  /** Refill all weapons + battery (on respawn, and whenever standing in the base). */
  private resupply(): void {
    this.resupplyAmmo();
    this.battery = BATTERY_MAX;
  }

  /** Soldiers (on foot) resupply AMMO by walking over a street crate. The pickup is broadcast so every
   *  client hides the same crate; crates respawn after a cooldown. Drones recharge at their base instead. */
  private ammoFrame(): void {
    if (this.mode === "free") return;
    this.ammoCrates.update(this.time);                            // tick respawns on every client
    if (!(this.player instanceof Walker) || this.hp <= 0) return; // only a living soldier grabs crates
    const p = this.player.camera.position;
    const i = this.ammoCrates.nearestLive(p.x, p.z);
    if (i < 0 || !this.resupplyAmmo()) return;                    // nothing near, or already full → don't waste it
    this.ammoCrates.take(i, this.time);
    if (this.net.connected) this.net.send({ t: "ammo", i });
    this.hud.flash("📦 Munición reabastecida");
    this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon]);
    this.audio.ui();
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
      this.hud.setWeapon(this.role, this.weapon, this.ammo[this.weapon]);
      this.hud.setKDA(this.myKills, this.myAssists, this.myDeaths);
      this.hud.setTeam(this.remotes.peers(), this.role);
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
  private applyDebrisImpacts(): void {
    const debris = this.debris.impacts();
    if (debris.length === 0) return;
    const tanks = this.gasTanks.map((t) => {
      const c = VoxelGrid.center(t.cx, t.cy, t.cz);
      return { x: c.x, y: c.y, z: c.z, live: t.live };
    });
    const p = this.player.camera.position;
    const drone = this.hp > 0 ? { x: p.x, y: p.y, z: p.z } : null;
    const out = resolveDebrisImpacts(debris, tanks, drone, {
      keThreshold: DEBRIS_IMPACT_KE, tankR: DEBRIS_HIT_TANK_R, droneR: DEBRIS_HIT_DRONE_R,
      dmgPerKe: 0.03, maxDronePerFrame: 25,
    });
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
    if (code === "keyo") { this.openSettings(); return; } // visual settings panel (all modes)
    if (code === "keyk") { this.cycleQuality(); return; } // graphics quality (all modes)
    if (code === "keym") { this.hud.flash(this.audio.toggleMute() ? "🔇 Silencio" : "🔊 Sonido"); return; } // mute toggle
    if (code === "keyf") { this.toggleFlashlight(); return; } // flashlight (all modes/roles)
    if (this.mode !== "free") {
      // Combat (vs/dvh): digit keys pick from the team weapon loadout (drone: 1-3, human: 1-4).
      const lo = roleLoadout(this.role);
      const idx = ["digit1", "digit2", "digit3", "digit4", "digit5", "digit6"].indexOf(code);
      if (idx >= 0 && idx < lo.length) { this.selectWeapon(lo[idx]); return; }
      if (code === "keyv") { this.meleeAttack(); return; } // melee (humans)
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
    this.player.update(dt, this.input); // player controller — the drone's KinematicCharacterController queries the building colliders
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
    this.aiFrame(dt);     // co-op: the host simulates + broadcasts the enemy drone swarm; peers render it
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
    if (this.hp <= 0) this.hud.showDeath(this.respawnAt - this.time); else this.hud.hideDeath(); // death overlay + live respawn countdown
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
      const sh = shakeOffset(this.trauma, this.time);
      const cam = this.player.camera;
      cam.position.x += sh.dx; cam.position.y += sh.dy; cam.position.z += sh.dz;
      if (sh.roll !== 0) cam.rotateZ(sh.roll);
      this.gpuTimer.begin();
      this.renderer.render(this.player.camera);
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
      this.mesher.rebuild(this.grid); this.seedMeshChunks();
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
        for (let i = 0; i < keys.length; i++) matIdx[i] = MATERIAL_ORDER.indexOf(this.grid.materialAt(keys[i])!);
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
