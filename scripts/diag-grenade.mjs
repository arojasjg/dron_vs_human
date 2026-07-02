import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=800,600"],
});
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto("http://localhost:5173/?ptex=256", { waitUntil: "networkidle2", timeout: 30000 });
await p.waitForFunction(() => window.__particles?.debugParticleMode?.(), { timeout: 20000 });

const out = await p.evaluate(() => {
  const g = window.__particles;
  const before = { stats: g.debugPhysicsStats(), stepMs: g.debugTimePhysics(30) };
  // one grenade-strength blast at the base of the free-standing wall
  g.debugBlast(9, 0.6, 1.75, 2.4, 360);
  const justAfter = g.debugPhysicsStats();
  // let it run a bit, then measure the steady-state physics cost
  g.debugTimePhysics(120);
  const settled = { stats: g.debugPhysicsStats(), stepMs: g.debugTimePhysics(60) };
  return { before, justAfter, settled };
});
await b.close();
console.log(JSON.stringify({ ...out, pageErrors: errs }, null, 2));
