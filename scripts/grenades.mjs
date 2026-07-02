import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:5173/`; // real GPU
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: false,
  args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=1400,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 820 });
const errors = [];
const steps = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { const t = m.text(); if (t.includes("[STEP]")) steps.push(t); });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 40000 });
await page.waitForFunction(() => !!window.__particles, { timeout: 30000 });
await sleep(2500);

// per-frame timing monitor + in-page burst (no CDP round-trips during the timing window)
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf(); // reset counters
  let i = 0;
  const fire = () => { if (i++ < 12) { window.__particles.debugLaunchGrenade(); setTimeout(fire, 500); } };
  fire();
});
await sleep(20 * 70 + 5500); // burst + fuses (1.6s) + collapses settle

const res = await page.evaluate(() => {
  const ft = window.__ft.slice();
  ft.sort((a, b) => a - b);
  const sum = ft.reduce((a, b) => a + b, 0);
  const avg = sum / ft.length;
  const p = (q) => ft[Math.min(ft.length - 1, Math.floor(ft.length * q))];
  return {
    frames: ft.length,
    avgFps: Math.round(1000 / avg),
    p50Ms: +p(0.5).toFixed(1),
    p99Ms: +p(0.99).toFixed(1),
    worstMs: +ft[ft.length - 1].toFixed(1),
    // perceptible-hitch histogram (a frame >~20ms is a visible jolt on a 60Hz display)
    over16: ft.filter((d) => d > 16).length,
    over25: ft.filter((d) => d > 25).length,
    over40: ft.filter((d) => d > 40).length,
    worst10: ft.slice(-10).map((d) => +d.toFixed(0)),
    floatingAfter: window.__particles.debugFloatingCount(),
    prof: window.__particles.debugFrameProf(),
  };
});

await browser.close();
console.log(JSON.stringify({ res, errors, steps: steps.slice(0, 12) }, null, 2));
