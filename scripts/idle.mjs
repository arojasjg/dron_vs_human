import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:5173/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POST = process.argv[2] === "post"; // measure idle AFTER a burst of destruction

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

if (POST) {
  await page.evaluate(() => window.__particles.debugBurst(15));
  await sleep(10000); // let the collapse fully settle (debris/chunk max-age is 6-7s)
}

await page.evaluate(() => {
  window.__ft = [];
  window.__t0 = performance.now();
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push([n - window.__t0, n - last]); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf();
});
await sleep(14000); // idle, do nothing

const res = await page.evaluate(() => {
  const ft = window.__ft.map((e) => e[1]);
  const sorted = [...ft].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const spikes = window.__ft.filter((e) => e[1] > 25).map((e) => [+(e[0] / 1000).toFixed(2), +e[1].toFixed(0)]);
  const gaps = [];
  for (let i = 1; i < spikes.length; i++) gaps.push(+(spikes[i][0] - spikes[i - 1][0]).toFixed(2));
  return {
    frames: ft.length,
    avgFps: Math.round(1000 / (ft.reduce((a, b) => a + b, 0) / ft.length)),
    medianMs: +p(0.5).toFixed(1),
    p95Ms: +p(0.95).toFixed(1),
    worstMs: +sorted[sorted.length - 1].toFixed(1),
    spikesOver25: spikes.length,
    spikeTimesSec: spikes.slice(0, 24),
    gapsSec: gaps.slice(0, 24),
    bodies: window.__particles.debugPhysicsStats(),
    prof: window.__particles.debugFrameProf(),
  };
});
await browser.close();
console.log(JSON.stringify({ POST, res, errors }, null, 2));
