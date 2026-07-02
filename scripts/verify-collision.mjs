import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://localhost:5173/?ptex=256";

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=1280,800"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
await page.waitForFunction(() => window.__particles?.debugParticleMode?.().startsWith("gpu"), { timeout: 20000 });

// Drop dust straight down onto the default free-standing wall, then advance the GPU
// sim deterministically (independent of headless render speed):
//   wall world footprint x in [6,12], z in [1.5,2], top surface y ~= 3.5
const probe = await page.evaluate(() => {
  const g = window.__particles;
  g.debugSetRepel(false); // isolate world-collision from particle-particle repulsion
  // low emit speed → particles fall almost straight onto the thin (0.5 m) wall top
  for (let i = 0; i < 10; i++) g.debugEmit(9, 6, 1.75, "debris", 1.0, 0.1, 9);
  g.debugStepParticles(240); // ~8 s of simulation, no wind
  return g.debugProbe(7, 11, 1.55, 1.95);
});
await page.screenshot({ path: "scripts/shot-collision.png" });
await browser.close();

console.log(JSON.stringify({ probe, pageErrors: errors }, null, 2));

const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (errors.length) fail("page errors");
if (!probe || probe.live <= 0) fail("no live particles");
if (probe.below !== 0) fail(`${probe.below} particles fell below ground (surface collision broken)`);
if (probe.count <= 20) fail(`only ${probe.count} particles over the wall (expected them to land there)`);
if (probe.maxY > 4.2) fail(`particles never fell from spawn y=6: maxY=${probe.maxY}`);
if (probe.minY < 3.0) fail(`particles passed through the wall: minY=${probe.minY} (wall top ~3.5)`);
console.log(`COLLISION OK — ${probe.count} particles fell from y=6 and rest on the wall at y≈${probe.minY.toFixed(2)}..${probe.maxY.toFixed(2)}, 0 below ground`);
