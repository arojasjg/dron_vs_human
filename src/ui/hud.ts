import { MATERIALS, type MaterialId } from "../world/materials";
import type { Role } from "../net/roles";

export type Tool = "shoot" | "grenade" | "cannon" | "missile" | "build" | "erase";
export type Mode = "free" | "vs" | "dvh";

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
<b>WASD</b> moverse · <b>Espacio/Ctrl</b> subir/bajar · <b>Shift</b> turbo
<b>Clic izq</b> usar arma · <b>Clic der</b> disparo rápido · <b>Rueda</b> brocha (construir)
<hr>
<b>1</b> Disparar &nbsp; <b>2</b> Granada &nbsp; <b>3</b> Cañón &nbsp; <b>4</b> Construir &nbsp; <b>5</b> Borrar &nbsp; <b>6</b> Misil
<b>Q/E</b> material (incluye 🛢 tambo de gas — explota en cadena)
<b>N</b> edificio &nbsp; <b>G</b> casa &nbsp; <b>B</b> muro &nbsp; <b>T</b> torre &nbsp; <b>V</b> auto &nbsp; <b>R</b> escena &nbsp; <b>C</b> vaciar
<b>P</b> guardar &nbsp; <b>L</b> cargar &nbsp; <b>F</b> caja &nbsp; <b>K</b> calidad (Bajo/Medio/Alto) &nbsp; <b>H</b> ocultar ayuda
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
    this.help.innerHTML = HELP;
  }

  /** DvH scoreboard: each team's kills and whether its objective still stands. */
  setScore(droneKills: number, humanKills: number, droneObjAlive: boolean, humanObjAlive: boolean): void {
    const obj = (alive: boolean) => (alive ? "🟢" : "💥");
    this.score.innerHTML = `🤖 Drones <b>${droneKills}</b> obj ${obj(droneObjAlive)} &nbsp;·&nbsp; obj ${obj(humanObjAlive)} <b>${humanKills}</b> Humanos 🧍`;
    this.score.style.display = "block";
  }

  hideScore(): void { this.score.style.display = "none"; }

  setMode(mode: Mode, room: string): void {
    const label = mode === "vs" ? "⚔ VS" : mode === "dvh" ? "🤖 vs 🧍 Drones vs Humanos" : "🛠 Libre";
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

  /** Start overlay: pick Libre or VS and a room, then begin. */
  showModeMenu(room: string, onStart: (mode: Mode, room: string) => void): void {
    const menu = document.getElementById("hud-menu")!;
    const input = document.getElementById("hud-room") as HTMLInputElement;
    input.value = room;
    menu.style.display = "flex";
    const pick = (mode: Mode) => {
      menu.style.display = "none";
      onStart(mode, (input.value.trim() || "lobby").slice(0, 32));
    };
    document.getElementById("hud-btn-free")!.onclick = () => pick("free");
    document.getElementById("hud-btn-vs")!.onclick = () => pick("vs");
    document.getElementById("hud-btn-dvh")!.onclick = () => pick("dvh");
  }

  setTool(tool: Tool): void {
    this.tool.textContent = TOOL_NAMES[tool];
  }

  setMaterial(id: MaterialId): void {
    const def = MATERIALS[id];
    const hex = "#" + def.color.toString(16).padStart(6, "0");
    this.mat.innerHTML = `<span class="sw" style="background:${hex}"></span>${def.name}`;
  }

  setStats(fps: number, debris: number, wind: number): void {
    this.stats.textContent = `${fps.toFixed(0)} fps · escombros ${debris} · viento ${wind.toFixed(1)}`;
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
    #hud { position: fixed; inset: 0; pointer-events: none; font-family: system-ui, sans-serif; color: #eef2f6; }
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
    #hud-mode { top: 14px; left: 50%; transform: translateX(-50%); display: none; font-size: 12px;
      letter-spacing: .4px; }
    #hud-health { bottom: 70px; left: 50%; transform: translateX(-50%); display: none; width: 240px;
      text-align: center; padding: 7px 10px; }
    #hud-health-bar { height: 12px; border-radius: 6px; background: rgba(255,255,255,.12); overflow: hidden; }
    #hud-health-fill { height: 100%; width: 100%; background: #35dd45; transition: width .12s, background .12s; }
    #hud-health-text { font-size: 11px; margin-top: 3px; font-variant-numeric: tabular-nums; }
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
    #hud-menu .room { display: flex; gap: 8px; align-items: center; justify-content: center; font-size: 12px; color: #9fb3c8; }
    #hud-room { pointer-events: auto; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.15);
      border-radius: 7px; padding: 6px 9px; color: #eef2f6; font-size: 13px; width: 130px; }
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
    <div id="hud-toast" class="panel"></div>
    <div id="crosshair"></div>
    <div id="hud-menu">
      <div class="card">
        <h1>PARTICLES</h1>
        <p>Drones de combate · destrucción física</p>
        <div class="row">
          <button id="hud-btn-free"><b>🛠 Libre</b><small>Sandbox: construir y destruir</small></button>
          <button id="hud-btn-vs"><b>⚔ VS</b><small>PvP: solo armas, vida y daño</small></button>
          <button id="hud-btn-dvh"><b>🤖 vs 🧍</b><small>Drones vs Humanos</small></button>
        </div>
        <div class="room">Sala <input id="hud-room" maxlength="32" /> <span>(comparte el código)</span></div>
      </div>
    </div>
    <div id="hud-win"></div>
  `;
  document.body.appendChild(hud);
}
