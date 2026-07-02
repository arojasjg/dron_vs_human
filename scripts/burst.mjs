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
await page.goto(URL, { waitUntil: "networkidle2", timeout: 40000 });
await page.waitForFunction(() => !!window.__particles, { timeout: 30000 });
await sleep(2500);

const N = Number(process.argv[2] ?? 50);
await page.evaluate((N) => {
  window.__ft = [];
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf();
  window.__particles.debugBurst(N); // N explosions in ONE tick → coalesced next frame
}, N);
await sleep(15000); // let the progressive collapse fully drain

const res = await page.evaluate(() => {
  const ft = window.__ft.slice().sort((a, b) => a - b);
  const sum = ft.reduce((a, b) => a + b, 0);
  const p = (q) => ft[Math.min(ft.length - 1, Math.floor(ft.length * q))];
  return {
    frames: ft.length,
    avgFps: Math.round(1000 / (sum / ft.length)),
    p95Ms: +p(0.95).toFixed(1),
    worstMs: +ft[ft.length - 1].toFixed(1),
    framesOver100ms: ft.filter((d) => d > 100).length,
    finalFps: Math.round(window.__particles.fps),
    floatingAfter: window.__particles.debugFloatingCount(),
    prof: window.__particles.debugFrameProf(),
  };
});
await browser.close();
console.log(JSON.stringify({ N, res, errors }, null, 2));
