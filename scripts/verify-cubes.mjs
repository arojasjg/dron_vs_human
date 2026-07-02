import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=1280,800"],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));

await p.goto("http://localhost:5173/?ptex=256", { waitUntil: "networkidle2", timeout: 30000 });
await p.waitForFunction(() => window.__particles?.debugParticleMode?.().startsWith("gpu"), { timeout: 20000 });

// No destruction → no CPU debris. Emit GPU particles in front of the camera so the
// ONLY possible cubes in the render come from the GPU LOD cube layer.
const out = await p.evaluate(() => {
  const g = window.__particles;
  // cubes render only for solid "debris" particles
  for (let i = 0; i < 6; i++) g.debugEmit(6, 4, 8, "debris", 1.0, 1.0, 9);
  g.debugStepParticles(10);
  return { cubeCount: g.debugCubeCount(), probe: g.debugProbe(3, 9, 5, 11) };
});
await p.screenshot({ path: "scripts/shot-cubes.png" });
await b.close();

console.log(JSON.stringify({ ...out, pageErrors: errs }, null, 2));
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (errs.length) fail("page errors");
if (out.cubeCount <= 0) fail("no cube instances allocated");
if (!out.probe || out.probe.live <= 0) fail("no live GPU particles near camera to render as cubes");
console.log(`CUBES OK — ${out.cubeCount} cube instances, ${out.probe.count} live particles in view (see shot-cubes.png)`);
