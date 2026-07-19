import { MATERIALS, type MaterialId } from "../world/materials";
import { classList, classStats, classLoadout, TEAM_LABEL, type Role } from "../net/roles";
import { WEAPONS, roleLoadout, type Weapon, type Ammo } from "../net/weapons";
import { MAP_SIZES } from "../build/prefabs";
import { ClassPreview } from "./classPreview";
import type { Quality } from "../engine/quality";
import type { VisualSettings } from "../engine/settings";
import { toRadar, compassMarks } from "./radar";

/** A minimap dot (a friend/enemy avatar) and a recent shot ray (from a shooter toward its fire direction). */
export interface RadarBlip { x: number; z: number; enemy: boolean; }
export interface RadarShot { x: number; z: number; dx: number; dz: number; life: number; }

export type Tool = "shoot" | "grenade" | "cannon" | "missile" | "build" | "erase";
// Selectable modes: "coop" (soldiers vs an AI drone swarm) and "dvh" (PvP, drone vs human). "vs"/"free" remain
// as dormant internal values (no menu entry) so the sandbox/deathmatch code compiles without a risky rip-out.
export type Mode = "coop" | "dvh" | "vs" | "free";

/** Start-menu callbacks: create a room in a mode (host, random code), or join an existing code. */
export interface MenuCallbacks {
  create: (mode: Mode) => void;
  join: (code: string) => void;
}
/** Lobby callbacks: pick your role/team/class (PvP), the host starts the match, or leave back to the menu. */
export interface LobbyCallbacks {
  pick: (role: Role) => void;
  start: () => void;
  leave: () => void;
  toggleHardcore?: () => void; // co-op host: flip permadeath vs respawn-while-a-teammate-lives
  pickTeam?: (team: 0 | 1) => void; // PvP: choose Rojo/Azul (independent of role)
  pickClass?: (cls: string) => void; // PvP: choose the class within the chosen role
  pickMapSize?: (size: string) => void; // host: choose the map size preset (all modes)
}
/** One roster row for the lobby list. */
export interface LobbyRow { id: number; role: Role | null; }

/** End-of-match overlay callbacks: replay the match, or drop back to the start menu. */
export interface GameOverCallbacks {
  restart: () => void;
  menu: () => void;
}

/** Callbacks the settings menu invokes on the game. `auto` returns the detected settings so the menu can
 *  repaint its controls to match. */
export interface SettingsCallbacks {
  setQuality: (q: Quality) => void;
  setResAuto: (on: boolean) => void;
  setResScale: (scale: number) => void;
  setViewDist: (metres: number) => void;
  auto: () => VisualSettings;
}

const TOOL_NAMES: Record<Tool, string> = {
  shoot: "Disparar (daña bloques)",
  grenade: "Granada",
  cannon: "Bola de cañón",
  missile: "Misil 🚀",
  build: "Construir",
  erase: "Borrar",
};

const HELP = `
<b>PARTICLES — FPS de destrucción</b>
<hr>
<b>Clic</b> en la pantalla para capturar el ratón · <b>Esc</b> suelta
<b>WASD</b> moverse · <b>Espacio</b> subir · <b>C</b> bajar/agacharse · <b>Shift</b> turbo · <b>F</b> linterna
<b>Clic izq</b> usar arma · <b>Clic der</b> disparo rápido · <b>Rueda</b> brocha (construir)
<hr>
<b>1</b> Disparar &nbsp; <b>2</b> Granada &nbsp; <b>3</b> Cañón &nbsp; <b>4</b> Construir &nbsp; <b>5</b> Borrar &nbsp; <b>6</b> Misil
<b>Q/E</b> material (incluye 🛢 tambo de gas — explota en cadena)
<b>N</b> edificio &nbsp; <b>G</b> casa &nbsp; <b>U</b> muro &nbsp; <b>T</b> torre &nbsp; <b>V</b> auto &nbsp; <b>R</b> escena &nbsp; <b>X</b> vaciar
<b>B</b> 💣 MEGA BOMBA (apuntá y explotá) &nbsp; <b>P</b> guardar &nbsp; <b>L</b> cargar &nbsp; <b>J</b> caja &nbsp; <b>K</b> calidad &nbsp; <b>O</b> ⚙ ajustes &nbsp; <b>M</b> silencio &nbsp; <b>H</b> ayuda
`;

export class Hud {
  private readonly minimap: HTMLCanvasElement;
  private readonly tool: HTMLElement;
  private readonly mat: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly help: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly win: HTMLElement;
  private readonly score: HTMLElement;
  private readonly weaponEl: HTMLElement;
  private classEl!: HTMLElement;          // class indicator next to the weapon bar
  private bandageEl!: HTMLElement;        // bandage count + channel progress
  private staminaEl!: HTMLElement;        // sprint stamina bar
  private lockEl!: HTMLElement;           // missile lock-on circle + target marker
  private lobbyCb: LobbyCallbacks | null = null; // held so updateLobby can wire the rebuilt class buttons
  private gameOverCb: GameOverCallbacks | null = null; // held so the game-over overlay's buttons stay wired across replays
  private preview: ClassPreview | null = null;   // lobby 3D class preview (dvh only; disposed on match start)
  private readonly battery: HTMLElement;
  private readonly batteryFill: HTMLElement;
  private readonly kda: HTMLElement;
  private readonly team: HTMLElement;
  private readonly dmg: HTMLElement;
  private readonly hit: HTMLElement;
  private readonly death: HTMLElement;
  private readonly killfeedEl: HTMLElement;
  private scannerEl!: HTMLElement;   // frontal-scanner status panel
  private scanMarks!: HTMLElement;   // on-screen directional markers container
  private toastTimer = 0;

  constructor() {
    inject();
    this.tool = document.getElementById("hud-tool")!;
    this.mat = document.getElementById("hud-mat")!;
    this.stats = document.getElementById("hud-stats")!;
    this.help = document.getElementById("hud-help")!;
    this.toast = document.getElementById("hud-toast")!;
    this.modeEl = document.getElementById("hud-mode")!;
    this.health = document.getElementById("hud-health")!;
    this.healthFill = document.getElementById("hud-health-fill")!;
    this.healthText = document.getElementById("hud-health-text")!;
    this.win = document.getElementById("hud-win")!;
    this.score = document.getElementById("hud-score")!;
    this.weaponEl = document.getElementById("hud-weapon")!;
    this.classEl = document.getElementById("hud-class")!;
    this.bandageEl = document.getElementById("hud-bandage")!;
    this.staminaEl = document.getElementById("hud-stamina")!;
    this.lockEl = document.getElementById("hud-lock")!;
    this.scannerEl = document.getElementById("hud-scanner")!;
    this.scanMarks = document.getElementById("hud-scanmarks")!;
    this.battery = document.getElementById("hud-battery")!;
    this.batteryFill = document.getElementById("hud-battery-fill")!;
    this.kda = document.getElementById("hud-kda")!;
    this.team = document.getElementById("hud-team")!;
    this.dmg = document.getElementById("hud-dmg")!;
    this.hit = document.getElementById("hud-hit")!;
    this.death = document.getElementById("hud-death")!;
    this.killfeedEl = document.getElementById("hud-killfeed")!;
    this.minimap = document.getElementById("hud-minimap") as HTMLCanvasElement;
    this.help.innerHTML = HELP;
    this.help.style.display = "none"; // hidden by default (uncluttered view); H toggles it back on
  }

  /** Draws the HEADING-UP minimap: a radar disc with the player at the centre (arrow = ahead), friends
   *  (green) / enemies (red) within `range`, and fading shot rays. `big` doubles the size + range. */
  drawMinimap(cx: number, cz: number, heading: number, blips: RadarBlip[], shots: RadarShot[], big: boolean, scanned: { x: number; z: number; behindWall: boolean }[] = []): void {
    const size = big ? 330 : 158, range = big ? 130 : 55, r = size / 2;
    if (this.minimap.width !== size) {
      this.minimap.width = this.minimap.height = size;
      this.minimap.style.width = this.minimap.style.height = `${size}px`; // style tracks the buffer size → same guard
    }
    const g = this.minimap.getContext("2d")!;
    g.clearRect(0, 0, size, size);
    g.beginPath(); g.arc(r, r, r - 1, 0, Math.PI * 2); g.fillStyle = "rgba(4,12,8,.62)"; g.fill();
    g.lineWidth = 1; g.strokeStyle = "rgba(107,255,158,.28)"; g.stroke();
    g.strokeStyle = "rgba(107,255,158,.12)"; g.beginPath(); g.arc(r, r, r * 0.5, 0, Math.PI * 2); g.stroke();
    for (const s of shots) { // shot rays: origin dot + a short line toward the fire direction
      const from = toRadar(heading, cx, cz, s.x, s.z, range, size);
      if (!from) continue;
      const to = toRadar(heading, cx, cz, s.x + s.dx * 8, s.z + s.dz * 8, range, size);
      g.strokeStyle = `rgba(255,182,56,${Math.min(0.9, s.life)})`; g.lineWidth = 2;
      g.beginPath(); g.moveTo(from[0], from[1]); g.lineTo(to ? to[0] : from[0], to ? to[1] : from[1]); g.stroke();
      g.fillStyle = `rgba(255,182,56,${Math.min(1, s.life)})`; g.beginPath(); g.arc(from[0], from[1], 2.6, 0, Math.PI * 2); g.fill();
    }
    for (const b of blips) {
      const p = toRadar(heading, cx, cz, b.x, b.z, range, size);
      if (!p) continue;
      g.fillStyle = b.enemy ? "#ff5236" : "#6bff9e";
      g.beginPath(); g.arc(p[0], p[1], big ? 4 : 3, 0, Math.PI * 2); g.fill();
    }
    // scanned enemies (frontal scanner): a distinct PULSING ring — cyan if behind a wall (revealed intel),
    // amber if in the open — so a scan contact reads apart from the normal red/green blips.
    if (scanned.length) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 170);
      for (const s of scanned) {
        const p = toRadar(heading, cx, cz, s.x, s.z, range, size);
        if (!p) continue;
        const col = s.behindWall ? "56,230,255" : "255,182,56";
        g.strokeStyle = `rgba(${col},${0.45 + pulse * 0.55})`; g.lineWidth = 2;
        g.beginPath(); g.arc(p[0], p[1], (big ? 7 : 5) + pulse * 2, 0, Math.PI * 2); g.stroke();
        g.fillStyle = `rgba(${col},0.95)`; g.beginPath(); g.arc(p[0], p[1], 2, 0, Math.PI * 2); g.fill();
      }
    }
    // compass: N/S/E/O around the edge, rotating with the heading so each letter points at its true world
    // direction (the N is amber to orient at a glance). Heading-up → whichever way you face is at the top.
    g.font = `${big ? 13 : 10}px ui-monospace, "Cascadia Code", Consolas, monospace`;
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const m of compassMarks(heading, size, big ? 15 : 11)) {
      g.fillStyle = m.label === "N" ? "#ffb638" : "rgba(107,255,158,.6)";
      g.fillText(m.label, m.x, m.y);
    }
    g.fillStyle = "#c9ffe0"; // player arrow at the centre, pointing up (= ahead)
    g.beginPath(); g.moveTo(r, r - 6); g.lineTo(r - 4.5, r + 5); g.lineTo(r + 4.5, r + 5); g.closePath(); g.fill();
  }

  /** Death overlay: fades the screen to dark FAST (~0.22s via the CSS transition) + a live respawn countdown.
   *  Idempotent — safe to call every frame. */
  showDeath(secondsLeft: number): void {
    const finite = isFinite(secondsLeft) && secondsLeft >= 0; // <0 / ∞ → no respawn coming (permadeath / last up)
    const html = finite
      ? `☠ Derribado<small>Reapareces en ${Math.max(0, Math.ceil(secondsLeft))}…</small>`
      : `☠ Derribado<small>Espectando…</small>`;
    if (this.death.innerHTML !== html) this.death.innerHTML = html;
    if (this.death.style.display !== "flex") this.death.style.display = "flex";
    if (this.death.style.opacity !== "1") this.death.style.opacity = "1"; // trigger the fade-to-dark
  }

  hideDeath(): void {
    if (this.death.style.opacity !== "0") this.death.style.opacity = "0";
    if (this.death.style.display !== "none") this.death.style.display = "none"; // snap back clear on respawn
  }

  /** Appends a killfeed line (auto-fades via CSS; keeps the last ~4). `mine` highlights our own kills. */
  killfeed(text: string, mine = false): void {
    const line = document.createElement("div");
    line.textContent = text;
    if (mine) line.className = "mine";
    this.killfeedEl.prepend(line);
    while (this.killfeedEl.childElementCount > 4) this.killfeedEl.lastElementChild!.remove();
    setTimeout(() => line.remove(), 4100); // matches the CSS fade
  }

  /** A red screen-edge pulse when we take damage (intensity 0..1 scales the peak opacity). */
  damageFlash(intensity: number): void {
    this.dmg.style.transition = "none";
    this.dmg.style.opacity = String(Math.min(0.85, 0.25 + intensity * 0.6));
    void this.dmg.offsetWidth;                    // force reflow so the fade restarts
    this.dmg.style.transition = "opacity .4s ease-out";
    this.dmg.style.opacity = "0";
  }

  /** A red arc at the screen edge pointing at where the hit came from. `angle`: 0 = ahead (top), + = right,
   *  ±π = behind (bottom). Rotating the full-screen glow places it at that bearing; it then fades out. */
  damageArrow(angle: number, intensity: number): void {
    const el = document.getElementById("hud-dmgdir")!;
    el.style.transition = "none";
    el.style.transform = `rotate(${angle}rad)`;
    el.style.opacity = String(Math.min(0.9, 0.4 + intensity * 0.5));
    void el.offsetWidth;                          // reflow so the fade restarts each hit
    el.style.transition = "opacity .7s ease-out";
    el.style.opacity = "0";
  }

  /** A crosshair hit marker: a quick white X on a confirmed hit, red + bigger on a kill. */
  hitMarker(kind: "hit" | "kill" = "hit"): void {
    this.hit.className = kind === "kill" ? "kill" : "";
    this.hit.style.transition = "none";
    this.hit.style.opacity = "1";
    this.hit.style.transform = kind === "kill" ? "scale(1.6)" : "scale(1)";
    void this.hit.offsetWidth;
    this.hit.style.transition = "opacity .2s ease-out, transform .2s ease-out";
    this.hit.style.opacity = "0";
  }

  /** DvH scoreboard: each team's kills and whether its objective still stands. */
  /** DvH scoreboard: each team's kills, its TWO bases (🟢 standing / 💥 razed) + the weakest base's HP%. */
  setScore(droneKills: number, humanKills: number, droneObjs: number, humanObjs: number, droneHp = 1, humanHp = 1): void {
    const bases = (n: number) => "🟢".repeat(Math.max(0, n)) + "💥".repeat(Math.max(0, 2 - n));
    const pct = (h: number) => `${Math.round(h * 100)}%`;
    const html = `🤖 Drones <b>${droneKills}</b> ${bases(droneObjs)}<small> ${pct(droneHp)}</small>` +
      ` &nbsp;·&nbsp; <small>${pct(humanHp)} </small>${bases(humanObjs)} <b>${humanKills}</b> Humanos 🧍`;
    if (this.score.innerHTML !== html) this.score.innerHTML = html; // called every frame → only touch the DOM on change
    if (this.score.style.display !== "block") this.score.style.display = "block";
  }

  hideScore(): void { this.score.style.display = "none"; }

  setMode(mode: Mode, room: string): void {
    const label = mode === "coop" ? "🪖 Co-op vs IA" : mode === "dvh" ? "⚔ Jugador vs Jugador (Dron vs Soldado)"
      : mode === "vs" ? "⚔ VS" : "🛠 Libre";
    this.modeEl.textContent = `${label} · sala ${room}`;
    this.modeEl.style.display = "block";
  }

  /** Wires the end-of-match overlay's buttons (Replay / Menu). Called once by the game so the buttons stay
   *  live across every game-over → replay cycle. */
  onGameOver(cb: GameOverCallbacks): void { this.gameOverCb = cb; }

  /** Builds the game-over card: the result message + the two action buttons (🔄 replay / 🏠 menu), wired to
   *  the stored callbacks, and shows the overlay. Shared by the PvP win and co-op game-over screens. */
  private renderGameOver(msg: string): void {
    this.win.innerHTML =
      `<div class="wcard"><div class="wmsg">${msg}</div>` +
      `<div class="wact">` +
      `<button id="hud-win-restart">🔄 Jugar de nuevo</button>` +
      `<button id="hud-win-menu">🏠 Menú</button>` +
      `</div></div>`;
    (document.getElementById("hud-win-restart") as HTMLButtonElement).onclick = () => this.gameOverCb?.restart();
    (document.getElementById("hud-win-menu") as HTMLButtonElement).onclick = () => this.gameOverCb?.menu();
    this.win.style.display = "flex";
  }

  /** Match-over overlay for Drones vs Humans. */
  showWin(winner: Role, myRole: Role): void {
    const team = winner === "drone" ? "los Drones 🤖" : "los Humanos 🧍";
    const head = winner === myRole ? "🏆 ¡Victoria!" : "☠ Derrota";
    this.renderGameOver(`${head}<br><span class="wsub">Ganaron ${team}</span>`);
  }

  hideWin(): void { this.win.style.display = "none"; }

  /** Co-op survival readout (reuses the score panel): drones killed this session + current wave. Called every
   *  frame → idempotent: only touches the DOM when the numbers actually change. */
  setCoopScore(kills: number, wave: number): void {
    const html = `🤖 Drones eliminados <b>${kills}</b> &nbsp;·&nbsp; 🌊 Oleada <b>${Math.max(1, wave)}</b>`;
    if (this.score.innerHTML !== html) this.score.innerHTML = html;
    if (this.score.style.display !== "block") this.score.style.display = "block";
  }

  /** Co-op session-over overlay (reuses the win overlay): final drones-killed + waves survived. */
  showGameOver(kills: number, wave: number): void {
    this.renderGameOver(`☠ Fin de la partida<br>` +
      `<span class="wsub">Drones eliminados: <b>${kills}</b> · Oleadas: <b>${Math.max(1, wave)}</b></span>`);
  }

  setHealth(hp: number, max: number, show: boolean): void {
    this.health.style.display = show ? "block" : "none";
    const f = Math.max(0, Math.min(1, hp / max));
    this.healthFill.style.width = `${f * 100}%`;
    this.healthFill.style.background = f > 0.5 ? "#6bff9e" : f > 0.25 ? "#ffb638" : "#ff5236";
    this.healthText.textContent = `${Math.ceil(hp)} HP`;
  }

  /** Weapon bar: every loadout weapon as a numbered icon (active one lit) + the active ammo (mag/reserve).
   *  `loadout` overrides the role default so the CLASS arsenal renders (falls back to the role loadout). */
  setWeapon(role: Role, active: Weapon, ammo: Ammo, loadout: Weapon[] = roleLoadout(role)): void {
    const slots = loadout.map((w, i) =>
      `<span class="wslot${w === active ? " on" : ""}">${WEAPONS[w].icon}<i>${i + 1}</i></span>`).join("");
    const spec = WEAPONS[active];
    const low = ammo.mag === 0 && ammo.reserve === 0;
    this.weaponEl.innerHTML = `<div class="wbar">${slots}</div>` +
      `<div class="wammo${low ? " empty" : ""}">${spec.icon} ${spec.name} · <b>${ammo.mag}</b><span>/${ammo.reserve}</span></div>`;
    this.weaponEl.style.display = "block";
  }

  /** Scope overlay: blurred/dimmed surroundings + a crisp ring & reticle (hiding the hip-fire dot) while ADS. */
  setScope(on: boolean): void {
    const v = on ? "1" : "0";
    document.getElementById("hud-scope")!.style.opacity = v;
    document.getElementById("hud-scope-ring")!.style.opacity = v;
    document.getElementById("crosshair")!.style.display = on ? "none" : "block";
  }

  /** Drone battery gauge. Pass frac < 0 to hide it (humans). */
  setBattery(frac: number): void {
    if (frac < 0) { this.battery.style.display = "none"; return; }
    this.battery.style.display = "block";
    const f = Math.max(0, Math.min(1, frac));
    this.batteryFill.style.width = `${f * 100}%`;
    this.batteryFill.style.background = f > 0.5 ? "#38e6ff" : f > 0.2 ? "#ffb638" : "#ff5236";
  }

  /** Personal scoreboard: kills / assists / deaths. */
  setKDA(kills: number, assists: number, deaths: number): void {
    this.kda.innerHTML = `<span class="tag">K</span><b>${kills}</b> <span class="tag">A</span><b>${assists}</b> <span class="tag">D</span><b>${deaths}</b>`;
    this.kda.style.display = "block";
  }

  /** Teammates' health (same team as `myRole`), as a small list of name + a mini health bar. */
  setTeam(peers: { id: number; hp: number; maxHp: number; isHuman: boolean; team: number }[], myTeam: number): void {
    const mine = peers.filter((p) => p.team === myTeam && p.id > 0); // AI bots (negative ids) are never teammates
    if (mine.length === 0) { this.team.style.display = "none"; return; }
    const tname = TEAM_LABEL[myTeam === 1 ? 1 : 0];
    this.team.innerHTML = `<div class="thead">Equipo ${tname}</div>` + mine.map((p) => {
      const f = Math.max(0, Math.min(1, p.hp / p.maxHp));
      const col = f > 0.5 ? "#6bff9e" : f > 0.25 ? "#ffb638" : "#ff5236";
      const icon = p.isHuman ? "🧍" : "🤖";
      return `<div class="trow">${icon} P${p.id}<div class="tbar"><div style="width:${f * 100}%;background:${col}"></div></div></div>`;
    }).join("");
    this.team.style.display = "block";
  }

  /** Combat HUD: the current class + team badge next to the weapon bar (PvP). Empty label hides it. */
  setClass(label: string, teamLabel: string): void {
    if (!label) { this.classEl.style.display = "none"; return; }
    this.classEl.innerHTML = `<b>${label}</b> <span>· ${teamLabel}</span>`;
    this.classEl.style.display = "block";
  }

  /** Bandage HUD: charge count (🩹 ×N) + a state-aware hint so it's clear WHEN you can heal. `count < 0` hides
   *  it (drones). `canHeal` = hurt AND have a bandage → prompt to press B (amber, panel pulses). `medkitNear` =
   *  a live medkit within reach → prompt to grab it (restock). While channelling, a progress bar + VENDANDO. */
  setBandages(count: number, healing: boolean, progress: number, canHeal = false, medkitNear = false): void {
    if (count < 0) { this.bandageEl.style.display = "none"; return; }
    let hint: string, alert = false;
    if (healing) {
      hint = `<div class="bnd-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%"></i></div><span class="bnd-do">VENDANDO…</span>`;
      alert = true;
    } else if (medkitNear) {
      hint = `<span class="bnd-do">🩹 Botiquín — pisa para recoger</span>`; alert = true;
    } else if (canHeal) {
      hint = `<span class="bnd-do">B — CURARTE</span>`; alert = true;          // hurt + have a bandage
    } else if (count === 0) {
      hint = `<span class="bnd-empty">Sin vendas · busca 🩹</span>`;           // out → find a medkit
    } else {
      hint = `<span class="bnd-hint">B — vendar</span>`;                       // have bandages, at full HP
    }
    const html = `<b>🩹 ×${count}</b> ${hint}`;
    if (this.bandageEl.innerHTML !== html) this.bandageEl.innerHTML = html; // called every frame → diff first
    this.bandageEl.classList.toggle("alert", alert);
    if (this.bandageEl.style.display !== "flex") this.bandageEl.style.display = "flex";
  }

  /** Sprint-stamina bar. Hidden at full rest (no clutter); shown while draining or recovering. `frac` 0..1,
   *  `exhausted` = spent → locked to walk (red pulse). `frac < 0` (drones/no soldier) hides it. */
  setStamina(frac: number, exhausted: boolean): void {
    if (frac < 0 || (frac >= 1 && !exhausted)) { if (this.staminaEl.style.display !== "none") this.staminaEl.style.display = "none"; return; }
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    const label = exhausted ? '<span class="stm-do">😮‍💨 Sin aliento</span>' : '<span class="stm-hint">Aliento</span>';
    const html = `<b>🏃</b> <div class="stm-bar"><i style="width:${pct}%"></i></div>${label}`;
    if (this.staminaEl.innerHTML !== html) this.staminaEl.innerHTML = html;
    this.staminaEl.classList.toggle("alert", exhausted);
    if (this.staminaEl.style.display !== "flex") this.staminaEl.style.display = "flex";
  }

  /** Frontal-scanner status panel. `state`: "ready" (glows amber, prompts R), "charging" (progress bar 0..1),
   *  or "off" (hidden — sandbox). Modeled on the bandage panel. */
  setScanStatus(state: "ready" | "charging" | "off", frac = 0): void {
    if (state === "off") { if (this.scannerEl.style.display !== "none") this.scannerEl.style.display = "none"; return; }
    const ready = state === "ready";
    const html = ready
      ? `<b>📡 ESCÁNER</b> <span class="scn-do">R — LISTO</span>`
      : `<b>📡 ESCÁNER</b> <div class="scn-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></i></div>`;
    if (this.scannerEl.innerHTML !== html) this.scannerEl.innerHTML = html; // called every frame → diff first
    this.scannerEl.classList.toggle("alert", ready);
    if (this.scannerEl.style.display !== "flex") this.scannerEl.style.display = "flex";
  }

  /** On-screen directional markers pointing at each scanned enemy. `marks[].angle` = bearing (rad, 0 = ahead,
   *  + = right); `behindWall` styles it cyan (intel) vs red (in the open). Empty clears them. Rebuilt per frame
   *  while pings are alive (≤ a dozen nodes → cheap); untouched when there's nothing to show. */
  setScanMarkers(marks: { angle: number; behindWall: boolean }[]): void {
    if (marks.length === 0) { if (this.scanMarks.childElementCount) this.scanMarks.innerHTML = ""; return; }
    this.scanMarks.innerHTML = marks.map((m) => {
      const deg = m.angle * 180 / Math.PI;
      return `<span class="scanmark ${m.behindWall ? "sm-wall" : "sm-see"}" style="transform:translate(-50%,-50%) rotate(${deg.toFixed(1)}deg) translateY(-34vh)">▲</span>`;
    }).join("");
  }

  /** Missile lock-on overlay: the centre acquire-CIRCLE (shown while the launcher is out) + a bracket on the
   *  target drone that fills as it acquires and flips red "LOCK" once held for the full second. */
  setLock(active: boolean, m: null | { x: number; y: number; progress: number; locked: boolean }): void {
    const el = this.lockEl;
    if (!active) { if (el.style.display !== "none") el.style.display = "none"; return; }
    let html = `<div class="lk-ring"></div>`;
    if (m) {
      const pct = Math.round(m.progress * 100);
      html += `<div class="lk-mark${m.locked ? " on" : ""}" style="left:${m.x.toFixed(1)}%;top:${m.y.toFixed(1)}%"><div class="lk-br"></div><span>${m.locked ? "🔒 FIJADO" : pct + "%"}</span></div>`;
    }
    if (el.innerHTML !== html) el.innerHTML = html;
    if (el.style.display !== "block") el.style.display = "block";
  }

  /** Start overlay: pick a mode to CREATE a room (host, gets a random code), or type a code to JOIN one. */
  showModeMenu(cb: MenuCallbacks): void {
    const menu = document.getElementById("hud-menu")!;
    const input = document.getElementById("hud-room") as HTMLInputElement;
    menu.style.display = "flex";
    const create = (mode: Mode) => { menu.style.display = "none"; cb.create(mode); };
    document.getElementById("hud-btn-coop")!.onclick = () => create("coop");
    document.getElementById("hud-btn-dvh")!.onclick = () => create("dvh");
    document.getElementById("hud-btn-join")!.onclick = () => {
      const code = input.value.trim().toUpperCase().slice(0, 8);
      if (code) { menu.style.display = "none"; cb.join(code); }
    };
  }

  /** Pre-match lobby: shows the shareable code, the roster, a role picker (PvP only), and — for the host —
   *  a Start button. `showLobby` wires it; `updateLobby` repaints the roster/host controls as peers change. */
  showLobby(code: string, mode: Mode, cb: LobbyCallbacks): void {
    this.lobbyCb = cb;
    const el = (id: string) => document.getElementById(id)!;
    el("lobby-code").textContent = code;
    el("lobby-title").textContent = mode === "coop" ? "🪖 Co-op vs IA" : "⚔ Jugador vs Jugador";
    el("lobby-roles").style.display = mode === "dvh" ? "flex" : "none"; // role/team only in PvP (co-op forces soldier)
    el("lobby-team").style.display = mode === "vs" ? "flex" : "none"; // dvh: team IS the role → no Rojo/Azul pick
    // class choice + 3D preview in BOTH PvP and co-op (co-op = pick your soldier class vs the AI)
    const classy = mode === "dvh" || mode === "coop";
    el("lobby-classes").style.display = classy ? "flex" : "none";
    el("lobby-mode").style.display = mode === "coop" ? "flex" : "none"; // death rule only in co-op
    el("lobby-mapsize").style.display = "flex"; // map size — every mode, host-only (enabled state set in updateLobby)
    for (const b of Array.from(document.querySelectorAll("#lobby-mapsize button[data-s]")) as HTMLButtonElement[])
      b.onclick = () => cb.pickMapSize?.(b.dataset.s!);
    // two panels with the live 3D class preview whenever a class is chosen (PvP + co-op). Recreate the preview
    // fresh (showLobby can run twice as the mode is learned); it's disposed on hideLobby / match start.
    el("lobby-side").style.display = classy ? "flex" : "none";
    this.preview?.dispose(); this.preview = null;
    if (classy) this.preview = new ClassPreview(el("lobby-preview") as HTMLCanvasElement);
    (el("lobby-copy") as HTMLButtonElement).onclick = () => { void navigator.clipboard?.writeText(code); this.flash("Código copiado"); };
    for (const b of Array.from(document.querySelectorAll("#lobby-roles button[data-r]")) as HTMLButtonElement[])
      b.onclick = () => cb.pick(b.dataset.r as Role);
    for (const b of Array.from(document.querySelectorAll("#lobby-team button[data-t]")) as HTMLButtonElement[])
      b.onclick = () => cb.pickTeam?.(Number(b.dataset.t) as 0 | 1);
    (el("lobby-hardcore") as HTMLButtonElement).onclick = () => cb.toggleHardcore?.();
    (el("lobby-start") as HTMLButtonElement).onclick = () => cb.start();
    (el("lobby-leave") as HTMLButtonElement).onclick = () => cb.leave();
    el("hud-lobby").style.display = "flex";
  }

  updateLobby(rows: LobbyRow[], myId: number, hostId: number, myRole: Role | null, myTeam = 0, myClass = "", myMap = "large", mode = ""): void {
    // dvh derives the team from the role, so the Rojo/Azul pick is dead there; only free vs keeps it
    if (mode) document.getElementById("lobby-team")!.style.display = mode === "vs" ? "flex" : "none";
    const list = document.getElementById("lobby-list")!;
    list.innerHTML = rows.map((p) => {
      const icon = p.role === "drone" ? "🤖" : p.role === "human" ? "🧍" : "❓";
      const tags = `${p.id === hostId ? " 👑" : ""}${p.id === myId ? " (tú)" : ""}`;
      return `<div class="lrow">${icon} Jugador ${p.id}${tags}</div>`;
    }).join("");
    const isHost = myId === hostId;
    (document.getElementById("lobby-start") as HTMLElement).style.display = isHost ? "inline-block" : "none";
    (document.getElementById("lobby-wait") as HTMLElement).style.display = isHost ? "none" : "inline";
    (document.getElementById("lobby-hardcore") as HTMLButtonElement).disabled = !isHost; // only the host sets the rule
    for (const b of Array.from(document.querySelectorAll("#lobby-roles button[data-r]")) as HTMLButtonElement[])
      b.classList.toggle("on", b.dataset.r === myRole);
    for (const b of Array.from(document.querySelectorAll("#lobby-team button[data-t]")) as HTMLButtonElement[])
      b.classList.toggle("on", b.dataset.t === String(myTeam));
    for (const b of Array.from(document.querySelectorAll("#lobby-mapsize button[data-s]")) as HTMLButtonElement[]) {
      const preset = MAP_SIZES[b.dataset.s as keyof typeof MAP_SIZES];
      if (preset) b.textContent = `${preset.label} · ${preset.players}`; // label + target players (kept in sync)
      b.classList.toggle("on", b.dataset.s === myMap);
      b.disabled = !isHost; // only the host chooses the map size; joiners see the choice
    }
    // class buttons depend on the chosen role → rebuild them (with the leading "Clase:" label) and wire each
    const classes = document.getElementById("lobby-classes")!;
    if (myRole) {
      classes.innerHTML = `<span>Clase:</span>` + classList(myRole).map((c) =>
        `<button data-c="${c.id}"${c.id === myClass ? ' class="on"' : ""}>${c.label}</button>`).join("");
      for (const b of Array.from(classes.querySelectorAll("button[data-c]")) as HTMLButtonElement[])
        b.onclick = () => this.lobbyCb?.pickClass?.(b.dataset.c!);
      // refresh the class-detail panel + swap the 3D preview model to the selected class (dvh only)
      this.renderClassDetail(myRole, myClass || "assault");
      if (this.preview) { this.preview.resize(); this.preview.setClass(myRole, myClass || "assault"); }
    }
  }

  /** Fills the lobby side panel with the class's stat bars, weapons and pros/cons (PvP class preview). */
  private renderClassDetail(role: Role, cls: string): void {
    const detail = document.getElementById("lobby-detail");
    if (!detail) return;
    const st = classStats(role, cls);
    const roleIcon = role === "drone" ? "🤖" : "🧍";
    const bar = (label: string, v: number, k = "") =>
      `<div class="cd-stat ${k}"><span>${label}</span><div class="cd-bar"><i style="width:${(v / 5) * 100}%"></i></div></div>`;
    const wpns = classLoadout(role, cls).map((w, i) => {
      const s = WEAPONS[w];
      const dmg = s.playerDmg != null ? `${s.playerDmg} daño` : s.fire;
      const rpm = s.cooldown > 0 ? ` · ${Math.round(60 / s.cooldown)} RPM` : "";
      return `<div class="cd-wpn${i === 0 ? " pri" : ""}"><span class="cd-wico">${s.icon}</span><div class="cd-wtxt"><b>${s.name}</b><i>${dmg}${rpm}</i></div></div>`;
    }).join("");
    const tags = (arr: string[], k: string, mark: string) =>
      `<div class="cd-tags">${arr.map((t) => `<span class="${k}">${mark} ${t}</span>`).join("")}</div>`;
    detail.innerHTML =
      `<div class="cd-name">${roleIcon} ${st.label} <span>· ${role === "drone" ? "DRON" : "SOLDADO"}</span></div>` +
      bar("Blindaje", st.profile.armor, "cd-arm") + bar("Movilidad", st.profile.mobility, "cd-mob") +
      bar("Alcance", st.profile.range) + bar("Fuego", st.profile.firepower) +
      `<div class="cd-sec">Armamento</div>${wpns}` +
      tags(st.pros, "cd-pro", "✓") + tags(st.cons, "cd-con", "✗");
  }

  /** Co-op lobby: reflect the chosen death rule on the toggle button. */
  setHardcore(on: boolean): void {
    const b = document.getElementById("lobby-hardcore");
    if (b) b.textContent = on ? "💀 Permadeath" : "🔁 Reaparecer";
  }

  hideLobby(): void {
    this.preview?.dispose(); this.preview = null; // free the preview's WebGL context before the match renders
    (document.getElementById("hud-lobby") as HTMLElement).style.display = "none";
  }

  /** Wires the always-visible gear button (opens the settings panel). Called once by the game. */
  onGear(open: () => void): void {
    (document.getElementById("hud-gear") as HTMLButtonElement).onclick = open;
  }

  /** Opens the visual-settings panel, populates it from `s`, and wires each control to `cb`. Live: every
   *  change applies immediately (and persists in the game). The AUTO button repaints from the detected result. */
  showSettings(s: VisualSettings, cb: SettingsCallbacks): void {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const qbtns = Array.from(document.querySelectorAll("#set-quality button")) as HTMLButtonElement[];
    const auto = $<HTMLInputElement>("set-res-auto");
    const res = $<HTMLInputElement>("set-res");
    const resVal = $<HTMLElement>("set-res-val");
    const view = $<HTMLInputElement>("set-view");
    const viewVal = $<HTMLElement>("set-view-val");

    const paintQ = (q: string) => qbtns.forEach((b) => b.classList.toggle("on", b.dataset.q === q));
    const paintRes = () => { res.disabled = auto.checked; resVal.textContent = auto.checked ? "Auto" : `${res.value}%`; };
    const paintView = () => { viewVal.textContent = `${view.value} m`; };
    const paintAll = (v: VisualSettings) => {
      paintQ(v.quality);
      auto.checked = v.resAuto;
      res.value = String(Math.round(v.resScale * 100));
      view.value = String(v.viewDist);
      paintRes(); paintView();
    };
    paintAll(s);

    qbtns.forEach((b) => { b.onclick = () => { const q = b.dataset.q as Quality; cb.setQuality(q); paintQ(q); }; });
    auto.onchange = () => { cb.setResAuto(auto.checked); paintRes(); };
    res.oninput = () => { auto.checked = false; cb.setResScale(+res.value / 100); paintRes(); };
    view.oninput = () => { cb.setViewDist(+view.value); paintView(); };
    $<HTMLButtonElement>("set-auto").onclick = () => paintAll(cb.auto());
    $<HTMLButtonElement>("set-close").onclick = () => this.hideSettings();
    $<HTMLElement>("hud-settings").style.display = "flex";
  }

  hideSettings(): void { (document.getElementById("hud-settings") as HTMLElement).style.display = "none"; }
  settingsOpen(): boolean { return (document.getElementById("hud-settings") as HTMLElement).style.display === "flex"; }

  setTool(tool: Tool): void {
    this.tool.textContent = TOOL_NAMES[tool];
  }

  setMaterial(id: MaterialId): void {
    const def = MATERIALS[id];
    const hex = "#" + def.color.toString(16).padStart(6, "0");
    this.mat.innerHTML = `<span class="sw" style="background:${hex}"></span>${def.name}`;
  }

  setStats(fps: number, debris: number, wind: number, drawCalls = -1, gpuMs = -1): void {
    // draw calls + real GPU-ms (timer query) are the two numbers that reveal a CPU-submit vs GPU-fill
    // bottleneck at a glance — shown so perf can be confirmed on the real machine (the automation tab
    // can't render). Hidden (-1) until the values exist.
    const perf = drawCalls >= 0 ? ` · draws ${drawCalls}` : "";
    const gpu = gpuMs >= 0 ? ` · gpu ${gpuMs.toFixed(1)}ms` : "";
    this.stats.textContent = `${fps.toFixed(0)} fps · escombros ${debris} · viento ${wind.toFixed(1)}${perf}${gpu}`;
  }

  toggleHelp(): void {
    this.help.style.display = this.help.style.display === "none" ? "block" : "none";
  }

  flash(msg: string): void {
    this.toast.textContent = msg;
    this.toast.style.opacity = "1";
    this.toastTimer = 1.6;
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.style.opacity = "0";
    }
  }
}

function inject(): void {
  const style = document.createElement("style");
  style.textContent = `
    #hud { --bg: rgba(6,14,10,.72); --bg2: rgba(4,10,7,.9); --bg-solid: #070f0b;
      --edge: rgba(107,255,158,.24); --edge2: rgba(107,255,158,.12); --tick: rgba(107,255,158,.5);
      --phos: #6bff9e; --phos-dim: #3f8c63; --amber: #ffb638; --red: #ff5236; --cyan: #38e6ff;
      --ink: #c9ffe0; --muted: #5f9a7c;
      --mono: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "DejaVu Sans Mono", monospace;
      position: fixed; inset: 0; pointer-events: none; font-family: var(--mono); color: var(--ink);
      z-index: 10; letter-spacing: .02em; }
    #hud-crt { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .55;
      box-shadow: inset 0 0 200px 46px rgba(0,0,0,.30);
      background:
        linear-gradient(var(--phos),var(--phos)) left 14px top 14px/22px 2px no-repeat,
        linear-gradient(var(--phos),var(--phos)) left 14px top 14px/2px 22px no-repeat,
        linear-gradient(var(--phos),var(--phos)) right 14px top 14px/22px 2px no-repeat,
        linear-gradient(var(--phos),var(--phos)) right 14px top 14px/2px 22px no-repeat,
        linear-gradient(var(--phos),var(--phos)) left 14px bottom 14px/22px 2px no-repeat,
        linear-gradient(var(--phos),var(--phos)) left 14px bottom 14px/2px 22px no-repeat,
        linear-gradient(var(--phos),var(--phos)) right 14px bottom 14px/22px 2px no-repeat,
        linear-gradient(var(--phos),var(--phos)) right 14px bottom 14px/2px 22px no-repeat,
        repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,.10) 2px 3px); }
    #hud .panel { position: absolute; padding: 9px 12px; font-size: 12px; line-height: 1.5; color: var(--ink);
      border: 1px solid var(--edge); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
      box-shadow: inset 0 0 22px rgba(0,0,0,.4), 0 2px 10px rgba(0,0,0,.35);
      background:
        linear-gradient(var(--tick),var(--tick)) left top/8px 1.5px no-repeat,
        linear-gradient(var(--tick),var(--tick)) left top/1.5px 8px no-repeat,
        linear-gradient(var(--tick),var(--tick)) right top/8px 1.5px no-repeat,
        linear-gradient(var(--tick),var(--tick)) right top/1.5px 8px no-repeat,
        linear-gradient(var(--tick),var(--tick)) left bottom/8px 1.5px no-repeat,
        linear-gradient(var(--tick),var(--tick)) left bottom/1.5px 8px no-repeat,
        linear-gradient(var(--tick),var(--tick)) right bottom/8px 1.5px no-repeat,
        linear-gradient(var(--tick),var(--tick)) right bottom/1.5px 8px no-repeat,
        var(--bg); }
    #hud-help { top: 14px; left: 14px; max-width: 366px; }
    #hud-help hr { border: none; border-top: 1px solid var(--edge2); margin: 7px 0; }
    #hud-help b { color: var(--phos); font-weight: 700; }
    #hud-stats { top: 14px; right: 14px; font-variant-numeric: tabular-nums; color: var(--muted); letter-spacing: .06em; }
    #hud-bottom { bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 16px; align-items: center; }
    #hud-bottom .tag { color: var(--phos-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .16em; }
    #hud .sw { display: inline-block; width: 12px; height: 12px; margin-right: 6px;
      vertical-align: -1px; border: 1px solid rgba(107,255,158,.4); }
    #hud-toast { bottom: 74px; left: 50%; transform: translateX(-50%); transition: opacity .3s; opacity: 0;
      background: var(--bg2); border: 1px solid var(--edge); padding: 8px 18px; font-size: 12px;
      letter-spacing: .12em; text-transform: uppercase; color: var(--phos); }
    #crosshair { position: absolute; top: 50%; left: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px;
      background:
        linear-gradient(var(--phos),var(--phos)) 50% 0/2px 7px no-repeat,
        linear-gradient(var(--phos),var(--phos)) 50% 100%/2px 7px no-repeat,
        linear-gradient(var(--phos),var(--phos)) 0 50%/7px 2px no-repeat,
        linear-gradient(var(--phos),var(--phos)) 100% 50%/7px 2px no-repeat,
        radial-gradient(circle at 50% 50%, var(--phos) 0 1px, transparent 1.6px) no-repeat;
      filter: drop-shadow(0 0 2px rgba(0,0,0,.85)); }
    #hud-dmg { position: fixed; inset: 0; pointer-events: none; opacity: 0; z-index: 11;
      box-shadow: inset 0 0 150px 34px rgba(255,60,40,.78); }
    #hud-dmgdir { position: fixed; inset: 0; pointer-events: none; opacity: 0; z-index: 11;
      background: radial-gradient(ellipse 55% 30% at 50% -8%, rgba(255,82,54,.85), transparent 72%); }
    #hud-minimap { position: absolute; bottom: 96px; right: 14px; pointer-events: none;
      filter: drop-shadow(0 2px 10px rgba(0,0,0,.6)); }
    /* Outside the scope circle the periphery stays 1× (NOT magnified) — we dim it + gently blur it
       (backdrop-filter), masked so the centre circle (the optical scope render) stays crisp. The transparent
       hole radius (30vh) matches the WebGL scope circle (SCOPE_CIRCLE_R 0.6) so its magnified edge isn't blurred. */
    #hud-scope { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 12;
      backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); background: rgba(4,8,6,.5);
      -webkit-mask: radial-gradient(circle at 50% 50%, transparent 0 30vh, #000 33.5vh);
      mask: radial-gradient(circle at 50% 50%, transparent 0 30vh, #000 33.5vh); }
    #hud-scope-ring { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 13; }
    #hud-scope-ring::before { content: ""; position: absolute; left: 50%; top: 50%; width: 60vh; height: 60vh; margin: -30vh 0 0 -30vh;
      border-radius: 50%; border: 2px solid rgba(0,0,0,.85); box-shadow: inset 0 0 26px 8px rgba(0,0,0,.32), 0 0 0 1px rgba(107,255,158,.22); }
    #hud-scope-ring::after { content: ""; position: absolute; left: 50%; top: 50%; width: 58vh; height: 58vh; margin: -29vh 0 0 -29vh;
      background: linear-gradient(rgba(107,255,158,.5),rgba(107,255,158,.5)) 50% 0/1px 100% no-repeat,
        linear-gradient(rgba(107,255,158,.5),rgba(107,255,158,.5)) 0 50%/100% 1px no-repeat; }
    #hud-hit { position: absolute; top: 50%; left: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; opacity: 0; }
    #hud-hit::before, #hud-hit::after { content: ""; position: absolute; left: 50%; top: 50%; width: 2px; height: 7px;
      margin: -3.5px 0 0 -1px; background: var(--phos); box-shadow: 0 0 3px rgba(0,0,0,.8); }
    #hud-hit::before { transform: rotate(45deg); } #hud-hit::after { transform: rotate(-45deg); }
    #hud-hit.kill::before, #hud-hit.kill::after { background: var(--red); height: 9px; margin-top: -4.5px; }
    #hud-mode { top: 14px; left: 50%; transform: translateX(-50%); display: none; font-size: 11px;
      letter-spacing: .16em; text-transform: uppercase; color: var(--phos-dim); }
    #hud-health { bottom: 70px; left: 50%; transform: translateX(-50%); display: none; width: 260px;
      text-align: center; padding: 8px 12px; }
    #hud-health-bar { position: relative; height: 12px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-health-fill { height: 100%; width: 100%; background: #6bff9e; transition: width .12s, background .12s;
      box-shadow: 0 0 10px rgba(107,255,158,.4); }
    #hud-health-bar::after { content: ""; position: absolute; inset: 0; pointer-events: none;
      background: repeating-linear-gradient(90deg, transparent 0 9px, var(--bg-solid) 9px 11px); }
    #hud-health-text { font-size: 11px; margin-top: 4px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--phos); font-variant-numeric: tabular-nums; }
    #hud-weapon { bottom: 112px; left: 50%; transform: translateX(-50%); display: none; text-align: center; padding: 8px 12px; }
    #hud-weapon .wbar { display: flex; gap: 7px; justify-content: center; margin-bottom: 6px; }
    #hud-weapon .wslot { position: relative; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
      font-size: 18px; background: rgba(6,14,10,.8); border: 1px solid var(--edge2); opacity: .5; filter: grayscale(.35);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%); }
    #hud-weapon .wslot.on { opacity: 1; background: rgba(107,255,158,.14); border-color: var(--phos);
      box-shadow: 0 0 14px rgba(107,255,158,.4); filter: none; }
    #hud-weapon .wslot i { position: absolute; bottom: -1px; right: 2px; font-size: 9px; font-style: normal; color: var(--phos-dim); }
    #hud-weapon .wslot.on i { color: var(--phos); }
    #hud-weapon .wammo { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; font-variant-numeric: tabular-nums; color: var(--ink); }
    #hud-weapon .wammo b { font-size: 16px; color: var(--amber); } #hud-weapon .wammo span { color: var(--muted); }
    #hud-weapon .wammo.empty { color: var(--red); } #hud-weapon .wammo.empty b { color: var(--red); }
    #hud-battery { bottom: 16px; left: 14px; width: 160px; }
    #hud-battery .cap { font-size: 9px; color: var(--phos-dim); display: block; margin-bottom: 4px; letter-spacing: .16em; text-transform: uppercase; }
    #hud-battery-bar { position: relative; height: 10px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-battery-fill { height: 100%; width: 100%; background: #38e6ff; transition: width .2s, background .2s;
      box-shadow: 0 0 10px rgba(56,230,255,.4); }
    #hud-battery-bar::after { content: ""; position: absolute; inset: 0; pointer-events: none;
      background: repeating-linear-gradient(90deg, transparent 0 9px, var(--bg-solid) 9px 11px); }
    #hud-kda { top: 48px; right: 14px; display: none; font-variant-numeric: tabular-nums; }
    #hud-kda .tag { color: var(--phos-dim); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; margin: 0 3px 0 10px; }
    #hud-kda .tag:first-child { margin-left: 0; }
    #hud-kda b { color: var(--ink); }
    #hud-team { top: 92px; right: 14px; display: none; min-width: 140px; }
    #hud-team .thead { font-size: 9px; color: var(--phos-dim); margin-bottom: 5px; text-transform: uppercase; letter-spacing: .16em; }
    #hud-team .trow { display: flex; align-items: center; gap: 7px; font-size: 11px; margin-top: 4px; }
    #hud-team .tbar { flex: 1; height: 6px; background: rgba(107,255,158,.12); overflow: hidden; }
    #hud-team .tbar div { height: 100%; }
    #hud-menu { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; backdrop-filter: blur(3px);
      background:
        radial-gradient(60% 55% at 50% 42%, rgba(16,46,34,.5), transparent 70%),
        repeating-linear-gradient(90deg, rgba(107,255,158,.05) 0 1px, transparent 1px 46px),
        repeating-linear-gradient(0deg, rgba(107,255,158,.04) 0 1px, transparent 1px 46px),
        rgba(3,7,5,.82); }
    #hud-menu .card { background: linear-gradient(180deg, rgba(10,20,15,.96), rgba(5,11,8,.96));
      border: 1px solid var(--edge); padding: 30px 34px; text-align: center; max-width: 440px;
      box-shadow: 0 20px 60px rgba(0,0,0,.6), inset 0 0 60px rgba(0,0,0,.4);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%); }
    #hud-menu h1 { margin: 0 0 6px; font-size: 30px; font-weight: 800; letter-spacing: .24em; color: var(--phos);
      text-shadow: 0 0 18px rgba(107,255,158,.5); padding-left: .24em; }
    #hud-menu p { margin: 0 0 20px; color: var(--phos-dim); font-size: 11px; letter-spacing: .28em; text-transform: uppercase; }
    #hud-menu .row { display: flex; gap: 14px; justify-content: center; margin-bottom: 16px; }
    #hud-menu button { pointer-events: auto; cursor: pointer; border: 1px solid var(--edge); color: var(--ink);
      background: linear-gradient(180deg, rgba(10,22,16,.9), rgba(6,14,10,.9)); padding: 16px 18px; font-size: 13px;
      font-family: var(--mono); flex: 1; text-align: left; transition: border-color .16s, box-shadow .16s, transform .16s;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%); }
    #hud-menu button:hover { border-color: var(--phos); box-shadow: inset 0 0 26px rgba(107,255,158,.12), 0 0 20px rgba(107,255,158,.16); transform: translateY(-2px); }
    #hud-menu button b { display: block; font-size: 15px; margin-bottom: 5px; color: var(--phos); letter-spacing: .04em; }
    #hud-menu button small { color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.5; }
    #hud-btn-vs { background: linear-gradient(180deg, rgba(30,10,8,.9), rgba(16,6,5,.9)); border-color: rgba(255,82,54,.4); }
    #hud-btn-vs b { color: var(--red); }
    #hud-btn-dvh { border-color: rgba(255,182,56,.35); } #hud-btn-dvh b { color: var(--amber); }
    #hud-score { position: absolute; top: 40px; left: 50%; transform: translateX(-50%); display: none;
      font-size: 12px; white-space: nowrap; letter-spacing: .08em; }
    #hud-score b { color: var(--phos); } #hud-score small { color: var(--muted); }
    #hud-win { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      font-family: var(--mono); font-weight: 800; font-size: 34px; letter-spacing: .1em; text-transform: uppercase;
      color: var(--phos); background: radial-gradient(rgba(4,16,10,.6), rgba(0,0,0,.82));
      pointer-events: auto; text-align: center; text-shadow: 0 0 18px rgba(107,255,158,.4); }
    #hud-win .wcard { display: flex; flex-direction: column; align-items: center; gap: 30px; }
    #hud-win .wmsg { line-height: 1.28; }
    #hud-win .wsub { font-size: 20px; font-weight: 400; }
    #hud-win .wact { display: flex; gap: 16px; }
    #hud-win .wact button { pointer-events: auto; cursor: pointer; font-family: var(--mono); font-size: 14px;
      font-weight: 700; letter-spacing: .12em; text-transform: uppercase; padding: 13px 26px; color: var(--ink);
      background: linear-gradient(180deg, rgba(10,20,15,.92), rgba(5,11,8,.92)); border: 1px solid var(--edge);
      text-shadow: none; transition: transform .12s, border-color .12s, box-shadow .12s, color .12s;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%); }
    #hud-win .wact button:hover { border-color: var(--phos); color: var(--phos);
      box-shadow: inset 0 0 22px rgba(107,255,158,.12), 0 0 18px rgba(107,255,158,.18); transform: translateY(-2px); }
    #hud-win-restart { border-color: var(--phos) !important; color: var(--phos) !important; }
    #hud-death { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center;
      justify-content: center; gap: 8px; font-family: var(--mono); font-weight: 800; font-size: 40px;
      letter-spacing: .06em; text-transform: uppercase; color: #ff9a88;
      background: radial-gradient(rgba(30,4,2,.66), rgba(0,0,0,.95)); pointer-events: none; text-shadow: 0 0 18px rgba(255,60,40,.5);
      opacity: 0; transition: opacity .22s ease-out; }
    #hud-death small { font-size: 16px; font-weight: 500; color: #ff7a68; letter-spacing: .16em; }
    #hud-killfeed { position: absolute; top: 52px; right: 14px; display: flex; flex-direction: column;
      align-items: flex-end; gap: 4px; pointer-events: none; }
    #hud-killfeed div { background: var(--bg2); border: 1px solid var(--edge2); padding: 3px 9px; font-size: 11px;
      letter-spacing: .04em; color: var(--ink); white-space: nowrap; animation: kf 4s forwards; }
    #hud-killfeed div.mine { border-color: var(--phos); box-shadow: 0 0 10px rgba(107,255,158,.2); color: var(--phos); }
    @keyframes kf { 0%{opacity:0; transform:translateX(8px)} 8%{opacity:1; transform:none} 82%{opacity:1} 100%{opacity:0} }
    #hud-menu .room { display: flex; gap: 10px; align-items: center; justify-content: center; font-size: 11px;
      color: var(--phos-dim); letter-spacing: .16em; text-transform: uppercase; }
    #hud-room { pointer-events: auto; background: rgba(0,0,0,.4); border: 1px solid var(--edge);
      color: var(--ink); padding: 8px 10px; font-size: 13px; width: 140px; font-family: var(--mono);
      letter-spacing: .3em; text-align: center; }
    #hud-room::placeholder { color: var(--phos-dim); letter-spacing: .3em; }
    #hud-btn-join { flex: 0 0 auto; text-align: center; padding: 8px 16px; font-size: 12px; text-transform: uppercase;
      letter-spacing: .16em; background: rgba(107,255,158,.1); border-color: var(--phos); color: var(--phos); clip-path: none; }
    #hud-gear { position: absolute; top: 12px; right: 150px; pointer-events: auto; cursor: pointer; width: 34px; height: 34px;
      border: 1px solid var(--edge); background: var(--bg); color: var(--phos);
      font-size: 16px; line-height: 1; backdrop-filter: blur(3px);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%); }
    #hud-gear:hover { background: rgba(107,255,158,.14); border-color: var(--phos); box-shadow: 0 0 12px rgba(107,255,158,.3); }
    #hud-settings { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; backdrop-filter: blur(3px);
      background:
        repeating-linear-gradient(90deg, rgba(107,255,158,.05) 0 1px, transparent 1px 46px),
        repeating-linear-gradient(0deg, rgba(107,255,158,.04) 0 1px, transparent 1px 46px),
        rgba(3,7,5,.82); }
    #hud-settings .scard { background: linear-gradient(180deg, rgba(10,20,15,.97), rgba(5,11,8,.97));
      border: 1px solid var(--edge); padding: 26px 28px; width: 360px; box-shadow: 0 20px 60px rgba(0,0,0,.6);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%); }
    #hud-settings h2 { margin: 0 0 16px; font-size: 16px; letter-spacing: .16em; text-transform: uppercase; color: var(--phos); }
    #hud-settings .srow { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 6px; font-size: 12px; }
    #hud-settings .slabel { color: var(--ink); letter-spacing: .06em; text-transform: uppercase; font-size: 11px; }
    #hud-settings .slabel b { color: var(--phos); font-variant-numeric: tabular-nums; }
    #hud-settings .sbtns { display: flex; gap: 6px; }
    #hud-settings .sbtns button { pointer-events: auto; cursor: pointer; border: 1px solid var(--edge); font-family: var(--mono);
      padding: 7px 13px; font-size: 12px; color: var(--ink); background: rgba(10,22,16,.7); text-transform: uppercase; letter-spacing: .1em; }
    #hud-settings .sbtns button.on { background: rgba(107,255,158,.16); border-color: var(--phos); color: var(--phos); }
    #hud-settings .schk { display: flex; align-items: center; gap: 6px; color: var(--phos-dim); cursor: pointer; text-transform: uppercase; font-size: 11px; letter-spacing: .1em; }
    #hud-settings .srange { width: 100%; margin: 2px 0 4px; accent-color: var(--phos); cursor: pointer; }
    #hud-settings .srange:disabled { opacity: .4; }
    #hud-settings .sactions { display: flex; gap: 10px; margin-top: 22px; }
    #hud-settings .sactions button { pointer-events: auto; cursor: pointer; flex: 1; border: 1px solid var(--edge); font-family: var(--mono);
      padding: 11px; font-size: 12px; color: var(--ink); background: rgba(10,22,16,.8); text-transform: uppercase; letter-spacing: .12em;
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%); }
    #hud-settings .sprimary { background: rgba(107,255,158,.14); border-color: var(--phos); color: var(--phos); }
    #hud-lobby { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; backdrop-filter: blur(3px);
      background:
        radial-gradient(60% 55% at 50% 42%, rgba(16,46,34,.5), transparent 70%),
        repeating-linear-gradient(90deg, rgba(107,255,158,.05) 0 1px, transparent 1px 46px),
        repeating-linear-gradient(0deg, rgba(107,255,158,.04) 0 1px, transparent 1px 46px),
        rgba(3,7,5,.86); }
    #hud-lobby .lcard { background: linear-gradient(180deg, rgba(10,20,15,.97), rgba(5,11,8,.97));
      border: 1px solid var(--edge); padding: 28px 32px; width: 400px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.6);
      clip-path: polygon(0 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%); }
    #hud-lobby h1 { margin: 0 0 12px; font-size: 20px; letter-spacing: .16em; text-transform: uppercase; color: var(--phos); }
    #hud-lobby .lcode { font-size: 12px; color: var(--phos-dim); letter-spacing: .16em; text-transform: uppercase; }
    #hud-lobby .lcode b { font-size: 30px; letter-spacing: .4em; color: var(--amber); font-variant-numeric: tabular-nums;
      margin: 0 8px; vertical-align: -2px; text-shadow: 0 0 12px rgba(255,182,56,.4); text-transform: none; }
    #hud-lobby .lcode button, #hud-lobby .lroles button, #hud-lobby .lactions button { pointer-events: auto;
      cursor: pointer; border: 1px solid var(--edge); color: var(--ink); font-family: var(--mono);
      background: rgba(10,22,16,.8); padding: 7px 13px; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; }
    #hud-lobby .lhint { color: var(--muted); font-size: 11px; margin: 10px 0 16px; letter-spacing: .1em; }
    #hud-lobby .lroles { display: flex; gap: 8px; align-items: center; justify-content: center; margin-bottom: 16px; font-size: 11px; color: var(--phos-dim); text-transform: uppercase; letter-spacing: .1em; }
    #hud-lobby .lclasses { flex-wrap: wrap; }
    #hud-lobby .lroles button.on { background: rgba(107,255,158,.18); border-color: var(--phos); color: var(--phos); }
    #hud-lobby #lobby-team button.tred { color: #ff6a6a; } #hud-lobby #lobby-team button.tblue { color: #6a9aff; }
    #hud-lobby #lobby-team button.tred.on { background: rgba(255,82,54,.2); border-color: #ff5236; color: #ff8a7a; }
    #hud-lobby #lobby-team button.tblue.on { background: rgba(74,138,255,.2); border-color: #4a8aff; color: #8ab0ff; }
    #hud-lobby #lobby-mapsize button:disabled { opacity: .4; cursor: default; }
    /* two-panel PvP lobby: left card + right class-preview side panel */
    #hud-lobby .lwrap { display: flex; gap: 16px; align-items: stretch; justify-content: center; max-width: 94vw; }
    #hud-lobby #lobby-side { width: 300px; display: flex; flex-direction: column; gap: 10px; text-align: left;
      background: linear-gradient(180deg, rgba(10,20,15,.97), rgba(5,11,8,.97)); border: 1px solid var(--edge); padding: 16px 18px;
      box-shadow: 0 20px 60px rgba(0,0,0,.6); clip-path: polygon(18px 0, 100% 0, 100% 100%, 0 100%, 0 18px); }
    #hud-lobby #lobby-preview { width: 100%; height: 220px; display: block; cursor: grab; touch-action: none;
      background: radial-gradient(70% 60% at 50% 40%, rgba(16,46,34,.5), rgba(3,7,5,.2)); border: 1px solid var(--edge2); }
    #hud-lobby #lobby-preview:active { cursor: grabbing; }
    #hud-lobby #lobby-detail { display: flex; flex-direction: column; gap: 9px; }
    #hud-lobby .cd-name { font-size: 16px; letter-spacing: .14em; text-transform: uppercase; color: var(--phos); }
    #hud-lobby .cd-name span { color: var(--muted); font-size: 10px; letter-spacing: .1em; }
    #hud-lobby .cd-stat { display: flex; align-items: center; gap: 8px; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--phos-dim); }
    #hud-lobby .cd-stat > span { width: 62px; flex: none; }
    #hud-lobby .cd-bar { position: relative; flex: 1; height: 9px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-lobby .cd-bar > i { display: block; height: 100%; background: var(--phos); box-shadow: 0 0 8px rgba(107,255,158,.4); }
    #hud-lobby .cd-bar::after { content: ""; position: absolute; inset: 0; pointer-events: none;
      background: repeating-linear-gradient(90deg, transparent 0 var(--seg, 9px), var(--bg-solid) var(--seg, 9px) calc(var(--seg, 9px) + 2px)); }
    #hud-lobby .cd-arm > i { background: var(--amber); box-shadow: 0 0 8px rgba(255,182,56,.4); }
    #hud-lobby .cd-mob > i { background: var(--cyan); box-shadow: 0 0 8px rgba(56,230,255,.4); }
    #hud-lobby .cd-sec { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
    #hud-lobby .cd-wpn { display: flex; align-items: center; gap: 8px; background: rgba(107,255,158,.05); border: 1px solid var(--edge2); padding: 5px 8px; }
    #hud-lobby .cd-wpn.pri { border-color: var(--phos); background: rgba(107,255,158,.12); }
    #hud-lobby .cd-wico { font-size: 16px; }
    #hud-lobby .cd-wtxt b { font-size: 11px; color: var(--ink); letter-spacing: .04em; }
    #hud-lobby .cd-wtxt i { display: block; font-size: 9px; color: var(--muted); font-style: normal; letter-spacing: .06em; font-variant-numeric: tabular-nums; }
    #hud-lobby .cd-tags { display: flex; flex-wrap: wrap; gap: 5px; }
    #hud-lobby .cd-pro, #hud-lobby .cd-con { font-size: 9px; letter-spacing: .06em; padding: 3px 7px; border: 1px solid var(--edge2); text-transform: uppercase; }
    #hud-lobby .cd-pro { color: var(--phos); border-color: rgba(107,255,158,.4); }
    #hud-lobby .cd-con { color: var(--red); border-color: rgba(255,82,54,.4); }
    #hud-class { bottom: 156px; left: 50%; transform: translateX(-50%); display: none; text-align: center;
      padding: 4px 12px; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
    #hud-class b { color: var(--amber); } #hud-class span { color: var(--phos-dim); }
    #hud-bandage { bottom: 16px; left: 182px; display: none; align-items: center; gap: 8px; padding: 6px 10px;
      font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    #hud-bandage b { color: var(--phos); font-size: 13px; }
    #hud-bandage .bnd-hint { color: var(--muted); font-size: 9px; }
    #hud-bandage .bnd-do { color: var(--amber); font-size: 10px; font-weight: 700; }
    #hud-bandage .bnd-empty { color: var(--red); font-size: 9px; }
    #hud-bandage .bnd-bar { position: relative; width: 60px; height: 8px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-bandage .bnd-bar i { display: block; height: 100%; background: var(--phos); box-shadow: 0 0 8px rgba(107,255,158,.4); }
    /* when you can actually heal (hurt+bandage) or a medkit is in reach, the panel glows amber + pulses to catch the eye */
    #hud-bandage.alert { border-color: var(--amber); box-shadow: 0 0 14px rgba(255,182,56,.35); animation: bndpulse 1s ease-in-out infinite; }
    @keyframes bndpulse { 0%,100% { box-shadow: 0 0 10px rgba(255,182,56,.25); } 50% { box-shadow: 0 0 20px rgba(255,182,56,.55); } }
    #hud-stamina { bottom: 52px; left: 182px; display: none; align-items: center; gap: 8px; padding: 6px 10px;
      font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    #hud-stamina b { color: #38e6ff; font-size: 13px; }
    #hud-stamina .stm-hint { color: var(--muted); font-size: 9px; }
    #hud-stamina .stm-do { color: var(--red); font-size: 10px; font-weight: 700; }
    #hud-stamina .stm-bar { position: relative; width: 60px; height: 8px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-stamina .stm-bar i { display: block; height: 100%; background: #38e6ff; box-shadow: 0 0 8px rgba(56,230,255,.4); transition: width .08s linear; }
    #hud-stamina.alert { border-color: var(--red); box-shadow: 0 0 14px rgba(255,82,54,.35); animation: bndpulse 1s ease-in-out infinite; }
    #hud-stamina.alert .stm-bar i { background: var(--red); box-shadow: 0 0 8px rgba(255,82,54,.5); }
    #hud-scanner { bottom: 16px; left: 330px; display: none; align-items: center; gap: 8px; padding: 6px 10px;
      font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    #hud-scanner b { color: var(--cyan); font-size: 12px; }
    #hud-scanner .scn-do { color: var(--cyan); font-size: 10px; font-weight: 700; }
    #hud-scanner .scn-bar { position: relative; width: 56px; height: 8px; background: rgba(0,0,0,.45); border: 1px solid var(--edge2); overflow: hidden; }
    #hud-scanner .scn-bar i { display: block; height: 100%; background: var(--cyan); box-shadow: 0 0 8px rgba(56,230,255,.4); }
    #hud-scanner.alert { border-color: var(--cyan); box-shadow: 0 0 14px rgba(56,230,255,.35); animation: scnpulse 1s ease-in-out infinite; }
    @keyframes scnpulse { 0%,100% { box-shadow: 0 0 10px rgba(56,230,255,.25); } 50% { box-shadow: 0 0 20px rgba(56,230,255,.55); } }
    /* on-screen directional markers pointing at scanned enemies (arrows around the crosshair) */
    #hud-scanmarks { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
    #hud-lock { position: absolute; inset: 0; pointer-events: none; z-index: 5; display: none; }
    #hud-lock .lk-ring { position: absolute; left: 50%; top: 50%; width: 26vh; height: 26vh; margin: -13vh 0 0 -13vh; border: 1px dashed rgba(255,182,56,.5); border-radius: 50%; }
    #hud-lock .lk-mark { position: absolute; transform: translate(-50%,-50%); color: var(--amber); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-align: center; white-space: nowrap; }
    #hud-lock .lk-mark .lk-br { width: 30px; height: 30px; border: 2px solid var(--amber); box-sizing: border-box; margin: 0 auto 3px; }
    #hud-lock .lk-mark.on { color: var(--red); }
    #hud-lock .lk-mark.on .lk-br { border-color: var(--red); animation: lkpulse .4s ease-in-out infinite; }
    @keyframes lkpulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.72); opacity: .7; } }
    .scanmark { position: absolute; top: 50%; left: 50%; font-size: 20px; line-height: 1; transform-origin: center;
      animation: smpulse 1s ease-in-out infinite; text-shadow: 0 0 8px currentColor; }
    .scanmark.sm-wall { color: var(--cyan); }
    .scanmark.sm-see { color: var(--red); }
    @keyframes smpulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
    #hud-lobby .llist { display: flex; flex-direction: column; gap: 6px; margin: 12px 0 20px; min-height: 40px; }
    #hud-lobby .lrow { background: rgba(107,255,158,.05); border: 1px solid var(--edge2); padding: 7px 10px; font-size: 12px; letter-spacing: .06em; }
    #hud-lobby .lactions { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    #hud-lobby #lobby-wait { color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    #hud-lobby .sprimary { background: rgba(107,255,158,.16); border-color: var(--phos); color: var(--phos); font-size: 14px; padding: 10px 20px; }
  `;
  document.head.appendChild(style);

  const hud = document.createElement("div");
  hud.id = "hud";
  hud.innerHTML = `
    <div id="hud-crt"></div>
    <div id="hud-help" class="panel"></div>
    <div id="hud-stats" class="panel"></div>
    <div id="hud-mode" class="panel"></div>
    <div id="hud-score" class="panel"></div>
    <div id="hud-bottom" class="panel">
      <span><span class="tag">Herramienta</span> <b id="hud-tool"></b></span>
      <span><span class="tag">Material</span> <b id="hud-mat"></b></span>
    </div>
    <div id="hud-health" class="panel">
      <div id="hud-health-bar"><div id="hud-health-fill"></div></div>
      <div id="hud-health-text">100 HP</div>
    </div>
    <div id="hud-weapon" class="panel"></div>
    <div id="hud-class" class="panel"></div>
    <div id="hud-bandage" class="panel"></div>
    <div id="hud-stamina" class="panel"></div>
    <div id="hud-scanner" class="panel"></div>
    <div id="hud-scanmarks"></div>
    <div id="hud-lock"></div>
    <div id="hud-battery" class="panel"><span class="cap">🔋 Batería</span><div id="hud-battery-bar"><div id="hud-battery-fill"></div></div></div>
    <div id="hud-kda" class="panel"></div>
    <div id="hud-team" class="panel"></div>
    <div id="hud-toast" class="panel"></div>
    <div id="crosshair"></div>
    <div id="hud-scope"></div>
    <div id="hud-scope-ring"></div>
    <div id="hud-hit"></div>
    <div id="hud-dmg"></div>
    <div id="hud-dmgdir"></div>
    <div id="hud-menu">
      <div class="card">
        <h1>PARTICLES</h1>
        <p>Drones de combate · destrucción física</p>
        <div class="row">
          <button id="hud-btn-coop"><b>🪖 Co-op vs IA</b><small>Soldados contra un enjambre de drones IA</small></button>
          <button id="hud-btn-dvh"><b>⚔ Jugador vs Jugador</b><small>Dron vs Soldado — elige tu bando</small></button>
        </div>
        <div class="room">Unirse: <input id="hud-room" maxlength="8" placeholder="CÓDIGO" /> <button id="hud-btn-join">Entrar</button></div>
      </div>
    </div>
    <div id="hud-lobby">
      <div class="lwrap">
      <div class="lcard">
        <h1 id="lobby-title">Sala</h1>
        <div class="lcode">Código <b id="lobby-code">—</b> <button id="lobby-copy">copiar</button></div>
        <p class="lhint">Comparte el código para que se unan.</p>
        <div id="lobby-roles" class="lroles"><span>Tu bando:</span>
          <button data-r="drone">🤖 Dron</button><button data-r="human">🧍 Soldado</button>
        </div>
        <div id="lobby-team" class="lroles" style="display:none"><span>Equipo:</span>
          <button data-t="0" class="tred">● Rojo</button><button data-t="1" class="tblue">● Azul</button>
        </div>
        <div id="lobby-classes" class="lroles lclasses" style="display:none"><span>Clase:</span></div>
        <div id="lobby-mapsize" class="lroles" style="display:none"><span>Mapa:</span>
          <button data-s="micro">Micro · 4</button><button data-s="small">Pequeño · 6</button><button data-s="medium">Mediano · 16</button><button data-s="large">Grande · 50</button>
        </div>
        <div id="lobby-mode" class="lroles" style="display:none"><span>Al morir:</span>
          <button id="lobby-hardcore">🔁 Reaparecer</button>
        </div>
        <div id="lobby-list" class="llist"></div>
        <div class="lactions">
          <button id="lobby-leave">Salir</button>
          <span id="lobby-wait">Esperando al anfitrión…</span>
          <button id="lobby-start" class="sprimary">▶ Iniciar</button>
        </div>
      </div>
      <div id="lobby-side">
        <canvas id="lobby-preview"></canvas>
        <div id="lobby-detail"></div>
      </div>
      </div>
    </div>
    <button id="hud-gear" title="Ajustes visuales (O)">⚙</button>
    <div id="hud-settings">
      <div class="scard">
        <h2>⚙ Ajustes visuales</h2>
        <div class="srow"><span class="slabel">Calidad</span>
          <div class="sbtns" id="set-quality">
            <button data-q="bajo">Bajo</button><button data-q="medio">Medio</button><button data-q="alto">Alto</button>
          </div>
        </div>
        <div class="srow"><span class="slabel">Resolución <b id="set-res-val"></b></span>
          <label class="schk"><input type="checkbox" id="set-res-auto"> Auto</label>
        </div>
        <input type="range" id="set-res" class="srange" min="50" max="100" step="5" />
        <div class="srow"><span class="slabel">Distancia de vista <b id="set-view-val"></b></span></div>
        <input type="range" id="set-view" class="srange" min="50" max="160" step="10" />
        <div class="sactions">
          <button id="set-auto" class="sprimary">🔍 Automático</button>
          <button id="set-close">Cerrar</button>
        </div>
      </div>
    </div>
    <div id="hud-win"></div>
    <div id="hud-death"></div>
    <div id="hud-killfeed"></div>
    <canvas id="hud-minimap"></canvas>
  `;
  document.body.appendChild(hud);
}
