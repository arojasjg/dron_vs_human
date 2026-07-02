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

// blast the lower floors right in front of the spawn, then let debris settle into rubble
await page.evaluate(() => {
  for (let i = 0; i < 14; i++) window.__particles.debugLaunchGrenade();
});
await sleep(9000); // debris falls, sleeps, and deposits persistent rubble

// idle FPS after everything settled
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__particles.debugFrameProf();
});
await sleep(4000);

const res = await page.evaluate(() => {
  const ft = window.__ft.slice().sort((a, b) => a - b);
  const sum = ft.reduce((a, b) => a + b, 0);
  return {
    idleAvgFps: Math.round(1000 / (sum / ft.length)),
    idleWorstMs: +ft[ft.length - 1].toFixed(1),
    idleSpikesOver25: ft.filter((d) => d > 25).length,
    bodies: window.__particles.debugPhysicsStats(),
    voxels: window.__particles.debugVoxelCount(),
    prof: window.__particles.debugFrameProf(),
  };
});
await page.screenshot({ path: "scripts/rubble.png" });
await browser.close();
console.log(JSON.stringify({ res, errors }, null, 2));
