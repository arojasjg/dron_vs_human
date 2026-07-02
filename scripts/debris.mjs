import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:5173/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: false,
  args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=1400,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 820 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => !!window.__particles, { timeout: 120000 });
const loadMs = Date.now() - t0;
await sleep(3000);

const mode = await page.evaluate(() => window.__particles.debugParticleMode());

// fire a burst of grenades into the building, then measure live GPU debris + FPS
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf();
  let i = 0;
  const fire = () => { if (i++ < 12) { window.__particles.debugLaunchGrenade(); setTimeout(fire, 120); } };
  fire();
});
await sleep(5000);

const res = await page.evaluate(() => {
  const ft = window.__ft.slice().sort((a, b) => a - b);
  const p = (q) => ft[Math.min(ft.length - 1, Math.floor(ft.length * q))];
  const probe = window.__particles.debugProbe(-1000, 1000, -1000, 1000);
  return {
    liveParticles: probe.live,        // total GPU debris/particles alive
    avgFps: Math.round(1000 / (ft.reduce((a, b) => a + b, 0) / ft.length)),
    p95Ms: +p(0.95).toFixed(1),
    worstMs: +ft[ft.length - 1].toFixed(1),
    framesOver100ms: ft.filter((d) => d > 100).length,
    prof: window.__particles.debugFrameProf(),
  };
});
await page.screenshot({ path: "scripts/debris.png" });
await browser.close();
console.log(JSON.stringify({ loadMs, mode, res, errors }, null, 2));
