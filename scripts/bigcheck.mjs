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
await sleep(3500);

const load = await page.evaluate(() => {
  const g = window.__particles;
  return {
    voxels: g.debugVoxelCount(),
    unsupportedAtLoad: g.debugUnsupportedCount(),
    phys: g.debugPhysicsStats(),
    drawCalls: g.renderer.renderer.info.render.calls,
  };
});

// pure idle frame times
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf();
});
await sleep(8000);
const idle = await page.evaluate(() => {
  const ft = window.__ft.slice().sort((a, b) => a - b);
  const p = (q) => ft[Math.min(ft.length - 1, Math.floor(ft.length * q))];
  return {
    avgFps: Math.round(1000 / (ft.reduce((a, b) => a + b, 0) / ft.length)),
    medianMs: +p(0.5).toFixed(1),
    p95Ms: +p(0.95).toFixed(1),
    worstMs: +ft[ft.length - 1].toFixed(1),
    spikesOver25: ft.filter((d) => d > 25).length,
    prof: window.__particles.debugFrameProf(),
  };
});

await browser.close();
console.log(JSON.stringify({ loadMs, load, idle, errors }, null, 2));
