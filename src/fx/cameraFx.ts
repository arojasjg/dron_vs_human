// Full-screen "camera" overlay that skins the view like a device feed: a DRONE gets an FPV look
// (cyan tint, centre reticle, corner brackets, ALT/VEL/BAT telemetry, scanlines) and a HUMAN gets a
// body-cam look (heavier vignette, warm grade, film grain, ● REC + live timestamp). Pure DOM/CSS +
// a tiny per-frame update — no post-processing pipeline. Sits under the HUD panels.

export type FxRole = "drone" | "human" | "none";

const GRAIN = "data:image/svg+xml;utf8," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter>" +
  "<rect width='120' height='120' filter='url(#n)'/></svg>");

export class CameraFx {
  private readonly root: HTMLElement;
  private readonly rec: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly tele: HTMLElement;
  private readonly label: HTMLElement;
  private role: FxRole = "none";
  private t = 0;
  private lastClockSec = -1; // the wall-clock string only changes once per second → skip identical rewrites

  constructor() {
    inject();
    this.root = document.getElementById("camfx")!;
    this.rec = document.getElementById("camfx-rec")!;
    this.clock = document.getElementById("camfx-clock")!;
    this.tele = document.getElementById("camfx-tele")!;
    this.label = document.getElementById("camfx-label")!;
  }

  setRole(role: FxRole): void {
    this.role = role;
    this.root.className = role === "none" ? "" : `fx-${role}`;
    this.root.style.display = role === "none" ? "none" : "block";
    this.label.textContent = role === "drone" ? "◉ DRON · FPV" : role === "human" ? "▮ BODYCAM" : "";
  }

  /** Per-frame: blink REC, tick the timestamp, jitter the grain, refresh telemetry. Cheap. */
  update(dt: number, tele: { speed: number; alt: number; battery: number }): void {
    if (this.role === "none") return;
    this.t += dt;
    this.rec.style.opacity = this.t % 1 < 0.5 ? "1" : "0.2"; // ~1 Hz REC blink
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== this.lastClockSec) {
      this.lastClockSec = nowSec;
      const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
      this.clock.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    this.tele.textContent = this.role === "drone"
      ? `ALT ${tele.alt.toFixed(1)}m   VEL ${tele.speed.toFixed(1)}m/s   BAT ${Math.round(tele.battery)}%`
      : `CAM-01   ${tele.speed.toFixed(1)} m/s`;
    this.root.style.setProperty("--gx", `${(Math.random() * 90) | 0}px`); // living grain
    this.root.style.setProperty("--gy", `${(Math.random() * 90) | 0}px`);
  }
}

function inject(): void {
  const style = document.createElement("style");
  style.textContent = `
    #camfx { position: fixed; inset: 0; pointer-events: none; z-index: 3; display: none;
      font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    #camfx > div { position: absolute; }
    #camfx .l { position: absolute; inset: 0; }
    /* vignette */
    #camfx .vig { background: radial-gradient(ellipse 75% 75% at 50% 50%, transparent 55%, rgba(0,0,0,.55) 100%); }
    #camfx.fx-human .vig { background: radial-gradient(ellipse 68% 68% at 50% 50%, transparent 48%, rgba(0,0,0,.72) 100%); }
    /* colour grade */
    #camfx.fx-drone .tint { background: linear-gradient(rgba(20,60,90,.10), rgba(0,20,40,.14)); mix-blend-mode: screen; }
    #camfx.fx-human .tint { background: linear-gradient(rgba(70,45,20,.16), rgba(30,15,5,.20)); mix-blend-mode: overlay; }
    /* scanlines */
    #camfx .scan { background: repeating-linear-gradient(0deg, rgba(0,0,0,.10) 0 1px, transparent 1px 3px); opacity: .5; }
    #camfx.fx-human .scan { opacity: .25; }
    /* film grain (jittered per frame) */
    #camfx .grain { background-image: url("${GRAIN}"); background-position: var(--gx,0) var(--gy,0);
      mix-blend-mode: overlay; opacity: .07; }
    #camfx.fx-human .grain { opacity: .12; }
    /* corner frame brackets */
    #camfx .cn { width: 34px; height: 34px; border: 2px solid rgba(255,255,255,.6); }
    #camfx.fx-drone .cn { border-color: rgba(120,210,255,.75); }
    #camfx .tl { top: 20px; left: 20px; border-right: none; border-bottom: none; }
    #camfx .tr { top: 20px; right: 20px; border-left: none; border-bottom: none; }
    #camfx .bl { bottom: 20px; left: 20px; border-right: none; border-top: none; }
    #camfx .br { bottom: 20px; right: 20px; border-left: none; border-top: none; }
    /* FPV reticle (drone only) */
    #camfx .ret { display: none; top: 50%; left: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px;
      border: 1px solid rgba(120,210,255,.5); border-radius: 50%; }
    #camfx.fx-drone .ret { display: block; }
    #camfx .ret::before, #camfx .ret::after { content: ""; position: absolute; background: rgba(120,210,255,.7); }
    #camfx .ret::before { left: 50%; top: -10px; width: 1px; height: 66px; margin-left: -.5px; }
    #camfx .ret::after { top: 50%; left: -10px; height: 1px; width: 66px; margin-top: -.5px; }
    /* text readouts */
    #camfx .rec { top: 22px; left: 62px; color: #ff3b30; font-size: 13px; font-weight: 700; letter-spacing: 1px; }
    #camfx .clock { top: 22px; right: 62px; color: rgba(255,255,255,.85); font-size: 12px; letter-spacing: .5px; }
    #camfx .tele { bottom: 24px; left: 62px; color: rgba(190,225,255,.9); font-size: 12px; letter-spacing: 1px; }
    #camfx.fx-human .tele { color: rgba(255,235,210,.9); }
    #camfx .label { bottom: 24px; right: 62px; color: rgba(255,255,255,.8); font-size: 12px; letter-spacing: 2px; }
  `;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "camfx";
  el.innerHTML = `
    <div class="l tint"></div><div class="l scan"></div><div class="l grain"></div><div class="l vig"></div>
    <div class="cn tl"></div><div class="cn tr"></div><div class="cn bl"></div><div class="cn br"></div>
    <div class="ret"></div>
    <div class="rec" id="camfx-rec">● REC</div>
    <div class="clock" id="camfx-clock"></div>
    <div class="tele" id="camfx-tele"></div>
    <div class="label" id="camfx-label"></div>`;
  document.body.appendChild(el);
}
