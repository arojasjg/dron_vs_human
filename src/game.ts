import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { DEBRIS_HIT_DRONE_R, DEBRIS_HIT_TANK_R, DEBRIS_IMPACT_KE, FIXED_DT, MAX_DEBRIS, MAX_DEBRIS_PER_EVENT, VOXEL } from "./config";
import { Player } from "./engine/player";
import { Walker } from "./engine/walker";
import { Input } from "./engine/input";
import { PerfGovernor } from "./engine/perfGovernor";
import { autoQuality, qualityConfig, QUALITY_ORDER, type Quality } from "./engine/quality";
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
import { BIG, buildBuilding, buildCar, buildDefaultScene, buildHouse, buildObjectives, buildTower, buildWall, objectiveAlive, OBJECTIVE_SITES, setWorldSeed } from "./build/prefabs";
import { Hud, type Mode, type Tool } from "./ui/hud";
import { Net, type NetMsg } from "./net/net";
import { RemoteDrones, MAX_HP } from "./net/remoteDrones";
import { assignRole, roleMaxHp, roleWeapon, type Role } from "./net/roles";
import { checkWin, reconcileKills, type MatchState } from "./net/objectives";
import { MATERIAL_ORDER, MATERIALS, type MaterialId } from "./world/materials";
import { packKey, unpackKey, VoxelGrid, type RayHit } from "./world/voxelGrid";
import { chunkCoord, VoxelCollider } from "./world/voxelCollider";
import { VoxelMesher } from "./world/voxelMesh";
import { connectedComponents, type Voxel } from "./world/structuralIntegrity";

// Support is solved on the COARSE CELL GRAPH (VoxelGrid.fallenCells). This is how many cells of
// lateral support a slab/beam may span to reach a column-cell — generous enough that destroying
// one support redistributes to neighbours (local damage, not a full vertical collapse).
const CELL_OVERHANG = 6;

/** Deterministic 32-bit hash of the room code → world seed (so all clients build the same world). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// Coarse cells dropped per frame during a collapse (progressive — a huge collapse spreads over
// frames instead of one stall).
const COLLAPSE_BUDGET = 48;

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
  private rebuildAllColliders = false;
  private readonly dirtyChunks = new Set<number>();      // chunks whose MESH needs rebuilding (prompt)
  private readonly dirtyCol = new Map<number, number>(); // chunk → last-touched time; collider rebuilt once quiet
  private structureDirty = false; // a blast changed the grid → re-solve the cell support graph
  // collision LOD: only the building chunks within this many CHUNKs of the player carry physics
  // colliders. Keeps the active collider count (and the broadphase cost) independent of building
  // size — the static world doesn't all live in the physics engine at once.
  private static readonly COLLIDER_RADIUS = 2;

  // Four spread spawn points across the ground-floor lobby (the 4 quadrants), clear of the NW
  // stairwell and the NE gas tank. Players are assigned one by their network id. World coords.
  private static readonly SPAWNS: [number, number, number][] = [
    [40 * VOXEL, 2.0, 40 * VOXEL],   // SW
    [248 * VOXEL, 2.0, 40 * VOXEL],  // SE
    [40 * VOXEL, 2.0, 176 * VOXEL],  // NW (east of the stairwell)
    [248 * VOXEL, 2.0, 176 * VOXEL], // NE (west of the gas tank)
  ];

  private prof = { settleMax: 0, settleTotal: 0, settleN: 0, spawnMax: 0, rebuildMax: 0, rebuildTotal: 0, physicsMax: 0, physicsTotal: 0, gpuMax: 0, gpuTotal: 0, renderMax: 0, renderTotal: 0 };

  private time = 0;
  private acc = 0;
  private last = performance.now();
  private fps = 60;

  // --- multiplayer ---
  private readonly net = new Net();
  private remotes!: RemoteDrones;
  private mode: Mode = "free";
  private quality: Quality = "medio";     // graphics preset (Bajo/Medio/Alto), K to cycle
  private role: Role = "drone";           // Drones-vs-Humans: our team
  private droneKills = 0;
  private humanKills = 0;
  private matchOver = false;
  private static readonly KILL_LIMIT = 15; // deathmatch limit (win also by destroying the enemy objective)
  private hp = MAX_HP;
  private netT = 0;          // throttle for state broadcasts
  private netSent = 0;       // diagnostic: count of state messages sent
  private respawnAt = 0;     // when dead, time to respawn
  private spawnIndex = 0;    // which of the 4 spawn points this player uses (by network id)

  private readonly tmpDir = new THREE.Vector3();
  private readonly crateGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  private readonly crateMat = new THREE.MeshStandardMaterial({ color: 0x9c6b34, roughness: 0.8, metalness: 0 });

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.input = new Input(this.renderer.renderer.domElement);
    this.player = new Player(this.physics);

    this.mesher = new VoxelMesher(this.renderer.scene);
    this.collider = new VoxelCollider(this.physics);
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

    // graphics quality: the user's saved choice, else auto-detected from the GPU (software → Bajo,
    // everything else → the safe middle with no IBL). Cycle live with K.
    const savedQ = (typeof localStorage !== "undefined" ? localStorage.getItem("quality") : null) as Quality | null;
    this.quality = savedQ && QUALITY_ORDER.includes(savedQ) ? savedQ : autoQuality(this.gpuName());
    // persist the resolved preset so MSAA (decided at renderer creation from this key) matches it next load
    if (typeof localStorage !== "undefined") localStorage.setItem("quality", this.quality);
    this.renderer.applyQuality(qualityConfig(this.quality, window.devicePixelRatio || 1));

    this.targets = { grid: this.grid, debris: this.debris, particles: this.sink };
    this.projectiles = new Projectiles(
      this.physics, this.renderer.scene, this.grid,
      (x, y, z, r, p) => this.explodeAt(x, y, z, r, p, true), // local weapon detonation → broadcast
      (hit, dx, dy, dz) => this.onBulletHit(hit, dx, dy, dz),
    );

    this.buildGround();
    this.initFlashes();
    buildDefaultScene(this.grid);
    this.mesher.rebuild(this.grid);
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

    this.input.onMouseDown = (b) => this.onMouseDown(b);
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
    const defRoom = params.get("room") || "lobby";
    const start = (mode: Mode, room: string) => {
      this.mode = mode;
      this.hp = this.myMaxHp();
      // identical world for everyone in the room (seed from the room code) → full destruction sync
      this.rebuildWorld(hashStr(room), mode === "free");
      this.net.connect(room);
      this.hud.setMode(mode, room);
      this.hud.setHealth(this.hp, this.myMaxHp(), true);
    };
    const urlMode = params.get("mode");
    if (urlMode === "vs" || urlMode === "free" || urlMode === "dvh") { start(urlMode, defRoom); return; } // headless/test path
    this.hud.showModeMenu(defRoom, start);
  }

  private onNet(m: NetMsg): void {
    if (m.t === "hello") {
      // got our network id → take the matching spawn point so players start apart
      this.spawnIndex = (this.net.id - 1) % Game.SPAWNS.length;
      if (this.mode === "dvh" || this.mode === "vs") this.assignRoleAndController();
      this.spawnPlayerInBuilding();
    } else if (m.t === "state") {
      this.remotes.upsert(m.id as number, m.x as number, m.y as number, m.z as number,
        m.qx as number, m.qy as number, m.qz as number, m.qw as number, m.hp as number, (m.role as Role) ?? "drone", (m.mhp as number) || MAX_HP);
      if (this.mode === "dvh" && typeof m.dk === "number") {
        const merged = reconcileKills({ drone: this.droneKills, human: this.humanKills }, { drone: m.dk as number, human: m.hk as number });
        this.droneKills = merged.drone; this.humanKills = merged.human;
        this.checkMatchWin();
      }
    } else if (m.t === "weapon") {
      this.fireRemoteWeapon(m);
    } else if (m.t === "explode") {
      this.explodeAt(m.x as number, m.y as number, m.z as number, m.r as number, m.p as number, false);
    } else if (m.t === "hit") {
      this.applyBulletHit(
        m.vx as number, m.vy as number, m.vz as number, m.dx as number, m.dy as number, m.dz as number,
        m.px as number, m.py as number, m.pz as number, m.nx as number, m.ny as number, m.nz as number,
      );
    } else if (m.t === "died") {
      this.addKill(m.role as Role); // a peer died → the enemy team scores
    } else if (m.t === "leave") {
      this.remotes.remove(m.id as number);
    }
  }

  /** DvH: derive our team from the network id (assignRole applied in id order → balanced, stable,
   *  identical on every client) and swap the local controller to a Walker if we're a human. */
  private assignRoleAndController(): void {
    this.role = assignRole([], this.net.id);
    const wantWalker = this.role === "human";
    if (wantWalker !== (this.player instanceof Walker)) {
      this.player.dispose();
      this.player = wantWalker ? new Walker(this.physics) : new Player(this.physics);
    }
    this.hp = this.myMaxHp(); // humans spawn tankier than drones
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
  }

  /** Local max HP: role-based in any versus mode (human tank, drone fragile), else the default. */
  private myMaxHp(): number { return this.mode === "dvh" || this.mode === "vs" ? roleMaxHp(this.role) : MAX_HP; }

  /** Scores a kill for the team opposing the victim, then checks for a match win. */
  private addKill(victim: Role): void {
    if (victim === "human") this.droneKills++; else this.humanKills++;
    this.checkMatchWin();
  }

  /** DvH win check: destroy the enemy objective or hit the kill limit. Objectives live in the
   *  synced grid, so every client reaches the same verdict. */
  private checkMatchWin(): void {
    if (this.mode !== "dvh" || this.matchOver || OBJECTIVE_SITES.length < 2) return;
    const has = (x: number, y: number, z: number) => this.grid.has(x, y, z);
    const droneObjAlive = objectiveAlive(OBJECTIVE_SITES[0], has);
    const humanObjAlive = objectiveAlive(OBJECTIVE_SITES[1], has);
    this.hud.setScore(this.droneKills, this.humanKills, droneObjAlive, humanObjAlive);
    const state: MatchState = { droneObjAlive, humanObjAlive, droneKills: this.droneKills, humanKills: this.humanKills };
    const winner = checkWin(state, Game.KILL_LIMIT);
    if (winner) { this.matchOver = true; this.hud.showWin(winner, this.role); }
  }

  /** Spawns a GHOST of a weapon a remote player fired — it flies for the visuals but never mutates
   *  the grid; the authoritative `explode`/`hit` message from that player does the actual damage. */
  private fireRemoteWeapon(m: NetMsg): void {
    const o = new THREE.Vector3(m.ox as number, m.oy as number, m.oz as number);
    const d = new THREE.Vector3(m.dx as number, m.dy as number, m.dz as number);
    if (m.k === "bullet") this.projectiles.launchBullet(o, d, 120, true);
    else if (m.k === "grenade") this.projectiles.launchGrenade(o, d, 22, true);
    else if (m.k === "missile") this.projectiles.launchRocket(o, d, 52, true);
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
    // respawn works in every mode, even offline (blasts/debris can kill you in the sandbox too)
    if (this.hp <= 0 && this.time >= this.respawnAt) {
      this.hp = this.myMaxHp();
      this.spawnPlayerInBuilding();
      this.hud.setHealth(this.hp, this.myMaxHp(), true);
    }
    if (!this.net.connected) return;
    this.netT -= dt;
    if (this.netT > 0) return;
    this.netT = 0.05; // ~20 Hz
    this.netSent++;
    const p = this.player.camera.position, q = this.player.camera.quaternion;
    this.net.send({
      t: "state",
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      qx: +q.x.toFixed(3), qy: +q.y.toFixed(3), qz: +q.z.toFixed(3), qw: +q.w.toFixed(3),
      hp: this.hp, mhp: this.myMaxHp(), role: this.role, // role → avatar; mhp → correct health bar
      dk: this.droneKills, hk: this.humanKills, // scoreboard → max-merged by peers (self-healing)
    });
  }

  /** Applies damage to our own drone (blasts + fast debris, in every mode) — computed locally on
   *  each client and broadcast via the periodic state message, so health stays consistent. */
  private damageDrone(amount: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.hud.setHealth(this.hp, this.myMaxHp(), true);
    if (this.hp <= 0) {
      this.respawnAt = this.time + 3;
      this.hud.flash("Derribado — reapareces en 3s");
      if (this.mode === "dvh") {
        this.net.send({ t: "died", role: this.role }); // tell peers so the enemy team scores
        this.addKill(this.role);                       // count it locally too (relay doesn't echo)
      }
    }
  }

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

  /** Cycles the graphics-quality preset live (Bajo → Medio → Alto) and persists the choice. */
  private cycleQuality(): void {
    this.quality = QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.quality) + 1) % QUALITY_ORDER.length];
    if (typeof localStorage !== "undefined") localStorage.setItem("quality", this.quality);
    this.renderer.applyQuality(qualityConfig(this.quality, window.devicePixelRatio || 1));
    this.hud.flash(`Calidad: ${this.quality.toUpperCase()}${this.quality === "bajo" ? " · recargá para quitar el suavizado" : ""}`);
  }

  start(): void {
    this.renderer.renderer.setAnimationLoop(() => this.frame());
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
    this.prof = { settleMax: 0, settleTotal: 0, settleN: 0, spawnMax: 0, rebuildMax: 0, rebuildTotal: 0, physicsMax: 0, physicsTotal: 0, gpuMax: 0, gpuTotal: 0, renderMax: 0, renderTotal: 0 };
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
    for (const ck of this.grid.fallenCells(CELL_OVERHANG)) n += this.grid.cellVoxelKeys(ck).length;
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
    this.mesher.rebuild(this.grid);
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
    const SEG = 96, SIZE = 400;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x3f4a2e), tint = new THREE.Color();
    const noise = (x: number, z: number) => Math.sin(x * 0.05) * Math.cos(z * 0.045) + 0.5 * Math.sin(x * 0.12 + z * 0.1);
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = -pos.getY(i);                                  // plane local → world XZ
      const edge = Math.max(0, Math.abs(wx) - 95, Math.abs(wz) - 80);            // 0 inside the city
      pos.setZ(i, Math.min(edge / 60, 1) * 4 * noise(wx, wz));                    // rolling hills only outside
      const shade = 0.72 + 0.28 * (0.5 + 0.5 * noise(wx * 1.7, wz * 1.7));        // mottled grass
      tint.copy(grass).multiplyScalar(shade);
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
    for (const p of this.props) { this.physics.world.removeRigidBody(p.body); this.renderer.scene.remove(p.mesh); }
    this.props.length = 0;
    this.grid.clear();
    buildDefaultScene(this.grid);
    if (this.mode === "dvh") {
      buildObjectives(this.grid); // a destructible core per team
      this.droneKills = 0; this.humanKills = 0; this.matchOver = false; this.hud.hideWin();
    }
    this.mesher.rebuild(this.grid);
    this.heightField.rebuild(this.grid);
    this.gpu?.setHeightField(this.heightField.texture, this.heightField.origin, this.heightField.size);
    this.rebuildGasTanks();
    this.collider.clear();
    this.streamColliders(true);
    this.structureDirty = false;
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

  private markChunkKey(ck: number): void {
    this.dirtyChunks.add(ck);        // mesh: rebuilt promptly (visual)
    this.dirtyCol.set(ck, this.time); // collider: debounced until this chunk stops changing
  }

  private markChunk(x: number, y: number, z: number): void {
    this.markChunkKey(packKey(chunkCoord(x), chunkCoord(y), chunkCoord(z)));
  }

  private markRegion(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    for (let cx = chunkCoord(x0); cx <= chunkCoord(x1); cx++)
      for (let cy = chunkCoord(y0); cy <= chunkCoord(y1); cy++)
        for (let cz = chunkCoord(z0); cz <= chunkCoord(z1); cz++) {
          this.markChunkKey(packKey(cx, cy, cz));
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
    let budget = initial ? Number.POSITIVE_INFINITY : 3;

    build:
    for (let cx = pcx - R; cx <= pcx + R; cx++)
      for (let cy = pcy - R; cy <= pcy + R; cy++)
        for (let cz = pcz - R; cz <= pcz + R; cz++) {
          if (budget <= 0) break build;
          if (this.collider.hasChunk(cx, cy, cz) || !this.grid.chunkNonEmpty(cx, cy, cz)) continue;
          this.collider.rebuildChunk(this.grid, cx, cy, cz);
          budget--;
        }

    const far = R + 2; // hysteresis so chunks at the edge don't thrash in/out
    const drop: number[] = [];
    for (const ck of this.collider.builtChunks()) {
      const [cx, cy, cz] = unpackKey(ck);
      if (Math.abs(cx - pcx) > far || Math.abs(cy - pcy) > far || Math.abs(cz - pcz) > far) drop.push(ck);
    }
    for (const ck of drop) {
      const [cx, cy, cz] = unpackKey(ck);
      this.collider.removeChunk(cx, cy, cz);
    }
  }

  private explodeAt(x: number, y: number, z: number, radius: number, power: number, broadcast = false): void {
    // A player-initiated blast is authoritative: broadcast its exact position so EVERY client carves
    // identically. Cascades (gas chains, collapse) are deterministic on the synced grid, so they run
    // locally on each client and are NOT broadcast (broadcast stays false for those calls).
    if (broadcast && this.net.connected) {
      this.net.send({ t: "explode", x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), r: radius, p: power });
    }
    const { removed } = explode(this.physics, this.targets, x, y, z, radius, power, (fx, fy, fz, r) => this.addFlash(fx, fy, fz, r));
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
      if (dist < dr) this.damageDrone(Math.round((1 - dist / dr) * 55));
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
    const fallen = this.grid.fallenCells(CELL_OVERHANG);
    if (fallen.length === 0) {
      this.structureDirty = false;
    } else {
      const matCount = new Map<MaterialId, number>();
      let sx = 0, sy = 0, sz = 0, nn = 0, cubes = 0;
      const limit = Math.min(fallen.length, COLLAPSE_BUDGET);
      for (let ci = 0; ci < limit; ci++) {
        for (const k of this.grid.cellVoxelKeys(fallen[ci])) {
          const x = (k % 1024) - 512, y = (Math.floor(k / 1024) % 1024) - 512, z = Math.floor(k / 1048576) - 512;
          const mat = this.grid.get(x, y, z);
          if (mat === undefined) continue;
          matCount.set(mat, (matCount.get(mat) ?? 0) + 1);
          sx += x; sy += y; sz += z; nn++;
          this.impactMarks.clearVoxel(k);
          this.grid.remove(x, y, z);
          this.markChunk(x, y, z);
          // a few pooled CPU cubes (sparse) for close-up rubble; GPU debris carries the mass
          if (cubes < MAX_DEBRIS_PER_EVENT && ((x + y + z) & 7) === 0) {
            const c = VoxelGrid.center(x, y, z);
            if (this.debris.spawn(c.x, c.y, c.z, mat, (Math.random() - 0.5) * 0.8, -0.2, (Math.random() - 0.5) * 0.8)) cubes++;
          }
        }
      }
      if (nn > 0) {
        let dom: MaterialId = "concrete", best = 0;
        for (const [m, c] of matCount) if (c > best) { best = c; dom = m; }
        const wc = VoxelGrid.center(Math.round(sx / nn), Math.round(sy / nn), Math.round(sz / nn));
        this.sink.burst(wc.x, wc.y, wc.z, {
          count: 0, color: 0, speed: 5, life: 12, kind: "debris",
          colorType: DEBRIS_CT[dom], strength: Math.min(0.9, 0.12 + nn / 80),
        });
        // VS: rubble falling on/near our drone hurts it (accumulates while buried)
        if (this.mode === "vs") {
          const p = this.player.camera.position;
          if (Math.hypot(p.x - wc.x, p.y - wc.y, p.z - wc.z) < 3) this.damageDrone(Math.min(8, nn / 18));
        }
      }
      // stays dirty → re-solve next frame to finish the budget / catch cascades
    }
    const d = performance.now() - _t0;
    this.prof.settleN++;
    this.prof.settleTotal += d;
    if (d > this.prof.settleMax) this.prof.settleMax = d;
  }

  /** Re-scans the grid for gas-tank clusters (call after building/loading). */
  private rebuildGasTanks(): void {
    const tankVox: Voxel[] = [];
    for (const [key, mat] of this.grid.cells) if (mat === "gastank") tankVox.push(unpackKey(key));
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

  // --- input -------------------------------------------------------------

  private onMouseDown(button: number): void {
    if (this.hp <= 0) return; // dead → wait for respawn
    const origin = this.player.camera.position;
    const dir = this.player.forward(this.tmpDir).clone();

    // VS is weapons-only (no construction / cannon) — force a weapon if a build tool is active
    if (this.mode === "vs" && (this.tool === "build" || this.tool === "erase" || this.tool === "cannon")) {
      this.tool = "shoot";
      this.hud.setTool("shoot");
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
          this.applyEdit(eraseVoxel(this.grid, origin, dir, this.brush));
        } else {
          this.applyEdit(placeVoxel(this.grid, origin, dir, MATERIAL_ORDER[this.matIndex], this.brush));
        }
        break;
      case "erase":
        this.applyEdit(eraseVoxel(this.grid, origin, dir, this.brush));
        break;
    }
  }

  private applyEdit(region: EditRegion | null): void {
    if (region) this.markRegion(region[0], region[1], region[2], region[3], region[4], region[5]);
  }

  private shoot(origin: THREE.Vector3, dir: THREE.Vector3): void {
    this.projectiles.launchBullet(origin, dir);
    this.broadcastWeapon("bullet", origin, dir);
  }

  /** Tells the other players we fired, so they see the projectile and its blast hits their drones. */
  private broadcastWeapon(k: string, o: THREE.Vector3, d: THREE.Vector3): void {
    if (!this.net.connected) return;
    this.net.send({
      t: "weapon", k,
      ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
      dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3),
    });
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
    if (mat === "gastank") { this.detonateTankAt(vx, vy, vz); return; } // deterministic chain (not broadcast)
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

    const def = MATERIALS[mat];
    const sp = 2.5;
    const evx = dx * sp + (Math.random() - 0.5);
    const evy = dy * sp + 1.0 + (Math.random() - 0.5);
    const evz = dz * sp + (Math.random() - 0.5);

    if (def.shatters) {
      // glass: a few quick shards, no dust cloud
      this.sink.burst(c.x, c.y, c.z, {
        count: 8, color: def.color, speed: 4, size: 4, life: 0.35,
        buoyancy: -1, windCoupling: 0.3, kind: "spark", strength: 0.02,
      });
    } else {
      // one real rigid chunk of the actual material + a small, short-lived dust puff
      this.debris.spawn(c.x, c.y, c.z, mat, evx, evy, evz);
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
    if (code === "keyk") { this.cycleQuality(); return; } // graphics quality (all modes)
    if (this.mode === "vs") {
      // VS = weapons only: no construction, cannon, prefab spawns, save/load
      switch (code) {
        case "digit1": this.setTool("shoot"); return;
        case "digit2": this.setTool("grenade"); return;
        case "digit6": this.setTool("missile"); return;
        case "keyh": this.hud.toggleHelp(); return;
        default: return;
      }
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
      case "keyb": { const [x, z] = this.groundTarget(); buildWall(this.grid, x, z); this.markAllDirty(); this.hud.flash("Muro"); return; }
      case "keyt": { const [x, z] = this.groundTarget(); buildTower(this.grid, x, z); this.markAllDirty(); this.hud.flash("Torre"); return; }
      case "keyv": { const [x, z] = this.groundTarget(); buildCar(this.grid, x, z); this.markAllDirty(); this.hud.flash("Auto"); return; }
      case "keyr": buildDefaultScene(this.grid); this.markAllDirty(); this.hud.flash("Escena inicial"); return;
      case "keyc": this.grid.clear(); this.markAllDirty(); this.hud.flash("Vaciado"); return;
      case "keyf": this.throwCrate(); return;
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
    for (const [key, mat] of this.grid.cells) {
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
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.time += dt;

    this.acc += dt;
    let steps = 0;
    const _tp = performance.now();
    while (this.acc >= FIXED_DT && steps < 2) {
      this.physics.step(this.time);
      this.acc -= FIXED_DT;
      steps++;
    }
    const _pd = performance.now() - _tp;
    this.prof.physicsTotal += _pd; if (_pd > this.prof.physicsMax) this.prof.physicsMax = _pd;
    // never try to "catch up" a backlog — that spirals when physics is heavy.
    // Better to run slightly slow-mo for a frame than to freeze.
    if (this.acc > FIXED_DT) this.acc = 0;

    this.player.update(dt, this.input);
    this.netUpdate(dt);
    if (this.mode === "dvh") this.checkMatchWin(); // detect an objective destroyed this frame
    this.streamColliders(); // keep building colliders only near the player (collision LOD)
    this.updateTankChain(dt);
    this.projectiles.update(dt);
    this.collapseStep(); // re-solve coarse support + drop a budget of fallen cells (progressive)
    this.debris.update(dt);
    this.applyDebrisImpacts(); // fast flying rubble hurts drones and sets off gas tanks
    const _tg = performance.now();
    if (this.gpu) this.gpu.update(dt, this.time, this.physics.wind);
    else this.particles.update(dt, this.physics.wind);
    const _gd = performance.now() - _tg;
    this.prof.gpuTotal += _gd; if (_gd > this.prof.gpuMax) this.prof.gpuMax = _gd;
    this.syncProps();
    this.updateFlashes(dt);
    // one budget scale drives BOTH the rigid-debris cap and the GPU particle emission, so under
    // load the whole spectacle throttles together (compatibility on weak/integrated GPUs).
    const budget = this.governor.update(this.fps);
    this.debris.cap = Math.round(MAX_DEBRIS * budget);
    if (this.gpu) this.gpu.emissionScale = budget;
    const _tr = performance.now();
    this.rebuildDirty();
    const _rd = performance.now() - _tr;
    this.prof.rebuildTotal += _rd; if (_rd > this.prof.rebuildMax) this.prof.rebuildMax = _rd;

    this.hud.update(dt);
    this.hud.setStats(this.fps, this.debris.count, Math.hypot(this.physics.wind.x, this.physics.wind.z));
    const _trn = performance.now();
    const cp = this.player.camera.position;
    this.renderer.followSun(cp.x, cp.y, cp.z); // keep the tight shadow frustum on the player
    this.renderer.render(this.player.camera);
    const _rn = performance.now() - _trn;
    this.prof.renderTotal += _rn; if (_rn > this.prof.renderMax) this.prof.renderMax = _rn;
  }

  /** Rebuilds only the geometry/colliders that changed this frame. */
  private rebuildDirty(): void {
    if (this.rebuildAllColliders) {
      this.collider.clear();           // drop all colliders…
      this.mesher.rebuild(this.grid);
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
    // Meshes (visual) first — prompt, but capped.
    if (this.dirtyChunks.size > 0) {
      for (const ck of this.dirtyChunks) {
        const [cx, cy, cz] = unpackKey(ck);
        this.mesher.rebuildChunk(this.grid, cx, cy, cz);
        this.dirtyChunks.delete(ck);
        if (performance.now() - _rt0 > 5) break;
      }
    }
    // Colliders churn the static broadphase (every edit re-costs world.step over all building
    // colliders), so only rebuild a chunk once it has STOPPED changing for a moment, and only a
    // little time per frame. The brief staleness only means a just-destroyed floor stays solid ~0.3s.
    if (this.dirtyCol.size > 0 && performance.now() - _rt0 < 8) {
      const COL_DELAY = 0.3;
      for (const [ck, t] of this.dirtyCol) {
        if (this.time - t < COL_DELAY) continue;
        const [cx, cy, cz] = unpackKey(ck);
        // only rebuild if this chunk is in the active LOD set; far ones get a fresh collider from
        // the (already-updated) grid when the player streams them back in
        if (this.collider.hasChunk(cx, cy, cz)) this.collider.rebuildChunk(this.grid, cx, cy, cz);
        this.dirtyCol.delete(ck);
        if (performance.now() - _rt0 > 8) break;
      }
    }
  }

  private syncProps(): void {
    for (const p of this.props) {
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
