import { MATERIALS, type MaterialId } from "../world/materials";
import type { Role } from "../net/roles";
import { WEAPONS, roleLoadout, type Weapon, type Ammo } from "../net/weapons";
import type { Quality } from "../engine/quality";
import type { VisualSettings } from "../engine/settings";

export type Tool = "shoot" | "grenade" | "cannon" | "missile" | "build" | "erase";
// Selectable modes: "coop" (soldiers vs an AI drone swarm) and "dvh" (PvP, drone vs human). "vs"/"free" remain
// as dormant internal values (no menu entry) so the sandbox/deathmatch code compiles without a risky rip-out.
export type Mode = "coop" | "dvh" | "vs" | "free";

/** Start-menu callbacks: create a room in a mode (host, random code), or join an existing code. */
export interface MenuCallbacks {
  create: (mode: Mode) => void;
  join: (code: string) => void;
}
/** Lobby callbacks: pick your role (PvP), the host starts the match, or leave back to the menu. */
export interface LobbyCallbacks {
  pick: (role: Role) => void;
  start: () => void;
  leave: () => void;
}
/** One roster row for the lobby list. */
export interface LobbyRow { id: number; role: Role | null; }

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
  private readonly battery: HTMLElement;
  private readonly batteryFill: HTMLElement;
  private readonly kda: HTMLElement;
  private readonly team: HTMLElement;
  private readonly dmg: HTMLElement;
  private readonly hit: HTMLElement;
  private readonly death: HTMLElement;
  private readonly killfeedEl: HTMLElement;
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
    this.battery = document.getElementById("hud-battery")!;
    this.batteryFill = document.getElementById("hud-battery-fill")!;
    this.kda = document.getElementById("hud-kda")!;
    this.team = document.getElementById("hud-team")!;
    this.dmg = document.getElementById("hud-dmg")!;
    this.hit = document.getElementById("hud-hit")!;
    this.death = document.getElementById("hud-death")!;
    this.killfeedEl = document.getElementById("hud-killfeed")!;
    this.help.innerHTML = HELP;
  }

  /** Death overlay with a live respawn countdown (seconds left). Idempotent — safe to call every frame. */
  showDeath(secondsLeft: number): void {
    const s = Math.max(0, Math.ceil(secondsLeft));
    const html = `☠ Derribado<small>Reapareces en ${s}…</small>`;
    if (this.death.innerHTML !== html) this.death.innerHTML = html;
    if (this.death.style.display !== "flex") this.death.style.display = "flex";
  }

  hideDeath(): void { if (this.death.style.display !== "none") this.death.style.display = "none"; }

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
    this.score.innerHTML = `🤖 Drones <b>${droneKills}</b> ${bases(droneObjs)}<small> ${pct(droneHp)}</small>` +
      ` &nbsp;·&nbsp; <small>${pct(humanHp)} </small>${bases(humanObjs)} <b>${humanKills}</b> Humanos 🧍`;
    this.score.style.display = "block";
  }

  hideScore(): void { this.score.style.display = "none"; }

  setMode(mode: Mode, room: string): void {
    const label = mode === "coop" ? "🪖 Co-op vs IA" : mode === "dvh" ? "⚔ Jugador vs Jugador (Dron vs Soldado)"
      : mode === "vs" ? "⚔ VS" : "🛠 Libre";
    this.modeEl.textContent = `${label} · sala ${room}`;
    this.modeEl.style.display = "block";
  }

  /** Match-over overlay for Drones vs Humans. */
  showWin(winner: Role, myRole: Role): void {
    const team = winner === "drone" ? "los Drones 🤖" : "los Humanos 🧍";
    const head = winner === myRole ? "🏆 ¡Victoria!" : "☠ Derrota";
    this.win.innerHTML = `${head}<br><span style="font-size:20px; font-weight:400">Ganaron ${team}</span>`;
    this.win.style.display = "flex";
  }

  hideWin(): void { this.win.style.display = "none"; }

  setHealth(hp: number, max: number, show: boolean): void {
    this.health.style.display = show ? "block" : "none";
    const f = Math.max(0, Math.min(1, hp / max));
    this.healthFill.style.width = `${f * 100}%`;
    this.healthFill.style.background = f > 0.5 ? "#35dd45" : f > 0.25 ? "#ddc233" : "#dd3a30";
    this.healthText.textContent = `${Math.ceil(hp)} HP`;
  }

  /** Weapon bar: every loadout weapon as a numbered icon (active one lit) + the active ammo (mag/reserve). */
  setWeapon(role: Role, active: Weapon, ammo: Ammo): void {
    const slots = roleLoadout(role).map((w, i) =>
      `<span class="wslot${w === active ? " on" : ""}">${WEAPONS[w].icon}<i>${i + 1}</i></span>`).join("");
    const spec = WEAPONS[active];
    const low = ammo.mag === 0 && ammo.reserve === 0;
    this.weaponEl.innerHTML = `<div class="wbar">${slots}</div>` +
      `<div class="wammo${low ? " empty" : ""}">${spec.icon} ${spec.name} · <b>${ammo.mag}</b><span>/${ammo.reserve}</span></div>`;
    this.weaponEl.style.display = "block";
  }

  /** Drone battery gauge. Pass frac < 0 to hide it (humans). */
  setBattery(frac: number): void {
    if (frac < 0) { this.battery.style.display = "none"; return; }
    this.battery.style.display = "block";
    const f = Math.max(0, Math.min(1, frac));
    this.batteryFill.style.width = `${f * 100}%`;
    this.batteryFill.style.background = f > 0.5 ? "#38d0ff" : f > 0.2 ? "#ddc233" : "#dd3a30";
  }

  /** Personal scoreboard: kills / assists / deaths. */
  setKDA(kills: number, assists: number, deaths: number): void {
    this.kda.innerHTML = `<span class="tag">K</span><b>${kills}</b> <span class="tag">A</span><b>${assists}</b> <span class="tag">D</span><b>${deaths}</b>`;
    this.kda.style.display = "block";
  }

  /** Teammates' health (same team as `myRole`), as a small list of name + a mini health bar. */
  setTeam(peers: { id: number; hp: number; maxHp: number; isHuman: boolean }[], myRole: Role): void {
    const mine = peers.filter((p) => p.isHuman === (myRole === "human"));
    if (mine.length === 0) { this.team.style.display = "none"; return; }
    const icon = myRole === "human" ? "🧍" : "🤖";
    this.team.innerHTML = `<div class="thead">Equipo ${icon}</div>` + mine.map((p) => {
      const f = Math.max(0, Math.min(1, p.hp / p.maxHp));
      const col = f > 0.5 ? "#35dd45" : f > 0.25 ? "#ddc233" : "#dd3a30";
      return `<div class="trow">${icon} P${p.id}<div class="tbar"><div style="width:${f * 100}%;background:${col}"></div></div></div>`;
    }).join("");
    this.team.style.display = "block";
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
    const el = (id: string) => document.getElementById(id)!;
    el("lobby-code").textContent = code;
    el("lobby-title").textContent = mode === "coop" ? "🪖 Co-op vs IA" : "⚔ Jugador vs Jugador";
    el("lobby-roles").style.display = mode === "dvh" ? "flex" : "none"; // role choice only in PvP
    (el("lobby-copy") as HTMLButtonElement).onclick = () => { void navigator.clipboard?.writeText(code); this.flash("Código copiado"); };
    for (const b of Array.from(document.querySelectorAll("#lobby-roles button[data-r]")) as HTMLButtonElement[])
      b.onclick = () => cb.pick(b.dataset.r as Role);
    (el("lobby-start") as HTMLButtonElement).onclick = () => cb.start();
    (el("lobby-leave") as HTMLButtonElement).onclick = () => cb.leave();
    el("hud-lobby").style.display = "flex";
  }

  updateLobby(rows: LobbyRow[], myId: number, hostId: number, myRole: Role | null): void {
    const list = document.getElementById("lobby-list")!;
    list.innerHTML = rows.map((p) => {
      const icon = p.role === "drone" ? "🤖" : p.role === "human" ? "🧍" : "❓";
      const tags = `${p.id === hostId ? " 👑" : ""}${p.id === myId ? " (tú)" : ""}`;
      return `<div class="lrow">${icon} Jugador ${p.id}${tags}</div>`;
    }).join("");
    const isHost = myId === hostId;
    (document.getElementById("lobby-start") as HTMLElement).style.display = isHost ? "inline-block" : "none";
    (document.getElementById("lobby-wait") as HTMLElement).style.display = isHost ? "none" : "inline";
    for (const b of Array.from(document.querySelectorAll("#lobby-roles button[data-r]")) as HTMLButtonElement[])
      b.classList.toggle("on", b.dataset.r === myRole);
  }

  hideLobby(): void { (document.getElementById("hud-lobby") as HTMLElement).style.display = "none"; }

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
    #hud { position: fixed; inset: 0; pointer-events: none; font-family: system-ui, sans-serif; color: #eef2f6; z-index: 10; }
    #hud .panel { position: absolute; background: rgba(12,16,22,.62); border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 10px 13px; font-size: 13px; line-height: 1.5; backdrop-filter: blur(6px); }
    #hud-help { top: 14px; left: 14px; max-width: 360px; }
    #hud-help hr { border: none; border-top: 1px solid rgba(255,255,255,.12); margin: 7px 0; }
    #hud-help b { color: #9fd0ff; font-weight: 600; }
    #hud-stats { top: 14px; right: 14px; font-variant-numeric: tabular-nums; }
    #hud-bottom { bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 14px; align-items: center; }
    #hud-bottom .tag { color: #9fb3c8; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
    #hud .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px;
      vertical-align: -1px; border: 1px solid rgba(255,255,255,.4); }
    #hud-toast { bottom: 70px; left: 50%; transform: translateX(-50%); transition: opacity .3s; opacity: 0;
      background: rgba(20,28,40,.8); padding: 8px 16px; border-radius: 20px; font-size: 13px; }
    #crosshair { position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
      border-radius: 50%; background: rgba(255,255,255,.85); box-shadow: 0 0 0 1.5px rgba(0,0,0,.5); }
    #hud-dmg { position: fixed; inset: 0; pointer-events: none; opacity: 0;
      box-shadow: inset 0 0 150px 34px rgba(200,20,20,.78); }
    #hud-hit { position: absolute; top: 50%; left: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; opacity: 0; }
    #hud-hit::before, #hud-hit::after { content: ""; position: absolute; left: 50%; top: 50%; width: 2px; height: 7px;
      margin: -3.5px 0 0 -1px; background: #fff; box-shadow: 0 0 2px #000; }
    #hud-hit::before { transform: rotate(45deg); } #hud-hit::after { transform: rotate(-45deg); }
    #hud-hit.kill::before, #hud-hit.kill::after { background: #ff5a4d; height: 9px; margin-top: -4.5px; }
    #hud-mode { top: 14px; left: 50%; transform: translateX(-50%); display: none; font-size: 12px;
      letter-spacing: .4px; }
    #hud-health { bottom: 70px; left: 50%; transform: translateX(-50%); display: none; width: 240px;
      text-align: center; padding: 7px 10px; }
    #hud-health-bar { height: 12px; border-radius: 6px; background: rgba(255,255,255,.12); overflow: hidden; }
    #hud-health-fill { height: 100%; width: 100%; background: #35dd45; transition: width .12s, background .12s; }
    #hud-health-text { font-size: 11px; margin-top: 3px; font-variant-numeric: tabular-nums; }
    #hud-weapon { bottom: 108px; left: 50%; transform: translateX(-50%); display: none; text-align: center; padding: 6px 10px; }
    #hud-weapon .wbar { display: flex; gap: 6px; justify-content: center; margin-bottom: 4px; }
    #hud-weapon .wslot { position: relative; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
      font-size: 18px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); opacity: .5; }
    #hud-weapon .wslot.on { opacity: 1; background: rgba(90,150,255,.28); border-color: rgba(120,180,255,.75); box-shadow: 0 0 10px rgba(90,150,255,.45); }
    #hud-weapon .wslot i { position: absolute; bottom: -3px; right: 1px; font-size: 9px; font-style: normal; color: #9fb3c8; }
    #hud-weapon .wammo { font-size: 13px; font-variant-numeric: tabular-nums; }
    #hud-weapon .wammo b { font-size: 16px; } #hud-weapon .wammo span { color: #9fb3c8; } #hud-weapon .wammo.empty { color: #dd3a30; }
    #hud-battery { bottom: 16px; left: 14px; width: 150px; }
    #hud-battery .cap { font-size: 10px; color: #9fb3c8; display: block; margin-bottom: 3px; }
    #hud-battery-bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,.12); overflow: hidden; }
    #hud-battery-fill { height: 100%; width: 100%; background: #38d0ff; transition: width .2s, background .2s; }
    #hud-kda { top: 48px; right: 14px; display: none; font-variant-numeric: tabular-nums; }
    #hud-kda .tag { color: #9fb3c8; font-size: 10px; margin: 0 3px 0 9px; } #hud-kda .tag:first-child { margin-left: 0; }
    #hud-team { top: 92px; right: 14px; display: none; min-width: 132px; }
    #hud-team .thead { font-size: 10px; color: #9fb3c8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
    #hud-team .trow { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-top: 3px; }
    #hud-team .tbar { flex: 1; height: 7px; border-radius: 4px; background: rgba(255,255,255,.12); overflow: hidden; }
    #hud-team .tbar div { height: 100%; }
    #hud-menu { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; background: rgba(6,9,14,.72); backdrop-filter: blur(3px); }
    #hud-menu .card { background: rgba(16,22,30,.96); border: 1px solid rgba(255,255,255,.1);
      border-radius: 14px; padding: 26px 30px; text-align: center; max-width: 380px; }
    #hud-menu h1 { margin: 0 0 4px; font-size: 22px; }
    #hud-menu p { margin: 0 0 16px; color: #9fb3c8; font-size: 13px; }
    #hud-menu .row { display: flex; gap: 12px; justify-content: center; margin-bottom: 14px; }
    #hud-menu button { pointer-events: auto; cursor: pointer; border: 1px solid rgba(255,255,255,.15);
      border-radius: 10px; padding: 14px 20px; font-size: 15px; color: #eef2f6; background: rgba(40,52,68,.9);
      flex: 1; }
    #hud-menu button b { display: block; font-size: 16px; margin-bottom: 3px; }
    #hud-menu button small { color: #9fb3c8; font-size: 11px; font-weight: 400; }
    #hud-btn-vs { background: rgba(80,30,34,.9); border-color: rgba(255,90,80,.4); }
    #hud-btn-dvh { background: rgba(30,48,80,.9); border-color: rgba(90,150,255,.45); }
    #hud-score { position: absolute; top: 40px; left: 50%; transform: translateX(-50%); display: none;
      font-size: 13px; white-space: nowrap; }
    #hud-win { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      font: 700 34px system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.55);
      pointer-events: none; text-align: center; text-shadow: 0 2px 14px #000; }
    #hud-death { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center;
      justify-content: center; gap: 6px; font: 700 40px system-ui, sans-serif; color: #ffd7d0;
      background: radial-gradient(rgba(60,0,0,.35), rgba(90,0,0,.72)); pointer-events: none; text-shadow: 0 2px 16px #000; }
    #hud-death small { font-size: 17px; font-weight: 500; color: #ffb3a8; }
    #hud-killfeed { position: absolute; top: 52px; right: 14px; display: flex; flex-direction: column;
      align-items: flex-end; gap: 4px; pointer-events: none; }
    #hud-killfeed div { background: rgba(15,20,30,.72); padding: 3px 9px; border-radius: 6px; font-size: 12px;
      color: #e6eef7; white-space: nowrap; animation: kf 4s forwards; }
    #hud-killfeed div.mine { border: 1px solid rgba(120,180,255,.6); }
    @keyframes kf { 0%{opacity:0; transform:translateX(8px)} 8%{opacity:1; transform:none} 82%{opacity:1} 100%{opacity:0} }
    #hud-menu .room { display: flex; gap: 8px; align-items: center; justify-content: center; font-size: 12px; color: #9fb3c8; }
    #hud-room { pointer-events: auto; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.15);
      border-radius: 7px; padding: 6px 9px; color: #eef2f6; font-size: 13px; width: 130px; }
    #hud-gear { position: absolute; top: 12px; right: 150px; pointer-events: auto; cursor: pointer; width: 34px; height: 34px;
      border-radius: 9px; border: 1px solid rgba(255,255,255,.14); background: rgba(12,16,22,.62); color: #cfe0f2;
      font-size: 17px; line-height: 1; backdrop-filter: blur(6px); }
    #hud-gear:hover { background: rgba(40,52,68,.9); }
    #hud-settings { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; background: rgba(6,9,14,.72); backdrop-filter: blur(3px); }
    #hud-settings .scard { background: rgba(16,22,30,.97); border: 1px solid rgba(255,255,255,.1);
      border-radius: 14px; padding: 22px 26px; width: 340px; }
    #hud-settings h2 { margin: 0 0 14px; font-size: 18px; }
    #hud-settings .srow { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 6px; font-size: 13px; }
    #hud-settings .slabel { color: #cfe0f2; } #hud-settings .slabel b { color: #9fd0ff; font-variant-numeric: tabular-nums; }
    #hud-settings .sbtns { display: flex; gap: 6px; }
    #hud-settings .sbtns button { pointer-events: auto; cursor: pointer; border: 1px solid rgba(255,255,255,.14);
      border-radius: 8px; padding: 6px 12px; font-size: 13px; color: #eef2f6; background: rgba(40,52,68,.7); }
    #hud-settings .sbtns button.on { background: rgba(90,150,255,.3); border-color: rgba(120,180,255,.75); }
    #hud-settings .schk { display: flex; align-items: center; gap: 5px; color: #9fb3c8; cursor: pointer; }
    #hud-settings .srange { width: 100%; margin: 2px 0 4px; accent-color: #5a96ff; cursor: pointer; }
    #hud-settings .srange:disabled { opacity: .4; }
    #hud-settings .sactions { display: flex; gap: 10px; margin-top: 20px; }
    #hud-settings .sactions button { pointer-events: auto; cursor: pointer; flex: 1; border: 1px solid rgba(255,255,255,.15);
      border-radius: 10px; padding: 11px; font-size: 14px; color: #eef2f6; background: rgba(40,52,68,.9); }
    #hud-settings .sprimary { background: rgba(30,48,80,.9); border-color: rgba(90,150,255,.5); }
    #hud-lobby { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      pointer-events: auto; background: rgba(6,9,14,.78); backdrop-filter: blur(3px); }
    #hud-lobby .lcard { background: rgba(16,22,30,.97); border: 1px solid rgba(255,255,255,.1); border-radius: 14px;
      padding: 24px 30px; width: 380px; text-align: center; }
    #hud-lobby h1 { margin: 0 0 10px; font-size: 22px; }
    #hud-lobby .lcode { font-size: 15px; color: #cfe0f2; }
    #hud-lobby .lcode b { font-size: 30px; letter-spacing: 4px; color: #7fd0ff; font-variant-numeric: tabular-nums;
      margin: 0 8px; vertical-align: -2px; }
    #hud-lobby .lcode button, #hud-lobby #lobby-roles button, #hud-lobby .lactions button { pointer-events: auto;
      cursor: pointer; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; color: #eef2f6;
      background: rgba(40,52,68,.85); padding: 6px 12px; font-size: 13px; }
    #hud-lobby .lhint { color: #9fb3c8; font-size: 12px; margin: 8px 0 14px; }
    #hud-lobby .lroles { display: flex; gap: 8px; align-items: center; justify-content: center; margin-bottom: 14px; font-size: 13px; color: #9fb3c8; }
    #hud-lobby #lobby-roles button.on { background: rgba(90,150,255,.32); border-color: rgba(120,180,255,.8); }
    #hud-lobby .llist { display: flex; flex-direction: column; gap: 5px; margin: 10px 0 18px; min-height: 40px; }
    #hud-lobby .lrow { background: rgba(255,255,255,.05); border-radius: 7px; padding: 6px 10px; font-size: 13px; }
    #hud-lobby .lactions { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    #hud-lobby #lobby-wait { color: #9fb3c8; font-size: 12px; }
    #hud-lobby .sprimary { background: rgba(30,60,40,.92); border-color: rgba(90,220,140,.5); font-size: 15px; padding: 10px 18px; }
  `;
  document.head.appendChild(style);

  const hud = document.createElement("div");
  hud.id = "hud";
  hud.innerHTML = `
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
    <div id="hud-battery" class="panel"><span class="cap">🔋 Batería</span><div id="hud-battery-bar"><div id="hud-battery-fill"></div></div></div>
    <div id="hud-kda" class="panel"></div>
    <div id="hud-team" class="panel"></div>
    <div id="hud-toast" class="panel"></div>
    <div id="crosshair"></div>
    <div id="hud-hit"></div>
    <div id="hud-dmg"></div>
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
      <div class="lcard">
        <h1 id="lobby-title">Sala</h1>
        <div class="lcode">Código <b id="lobby-code">—</b> <button id="lobby-copy">copiar</button></div>
        <p class="lhint">Comparte el código para que se unan.</p>
        <div id="lobby-roles" class="lroles"><span>Tu bando:</span>
          <button data-r="drone">🤖 Dron</button><button data-r="human">🧍 Soldado</button>
        </div>
        <div id="lobby-list" class="llist"></div>
        <div class="lactions">
          <button id="lobby-leave">Salir</button>
          <span id="lobby-wait">Esperando al anfitrión…</span>
          <button id="lobby-start" class="sprimary">▶ Iniciar</button>
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
  `;
  document.body.appendChild(hud);
}
