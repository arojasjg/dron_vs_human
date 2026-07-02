import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://localhost:5173/?ptex=256";

const b = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=800,600"],
});
const page = await b.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

async function run(repel) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => window.__particles?.debugParticleMode?.().startsWith("gpu"), { timeout: 20000 });
  return page.evaluate((repel) => {
    const g = window.__particles;
    g.debugSetRepel(repel);
    // tight, slow cluster dropped on open ground far from any structure
    for (let i = 0; i < 8; i++) g.debugEmit(-20, 5, -20, "debris", 1.0, 0.3, 12);
    g.debugStepParticles(240);
    return g.debugSpread(-20, -20, 12);
  }, repel);
}

const off = await run(false);
const on = await run(true);
await b.close();

const ratio = on.rms / (off.rms || 1e-6);
console.log(JSON.stringify({ off, on, spreadRatio: ratio, pageErrors: errs }, null, 2));

const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (errs.length) fail("page errors");
if (off.count < 100 || on.count < 100) fail("cluster did not form");
if (ratio < 1.3) fail(`repulsion did not spread the pile: rms off=${off.rms.toFixed(3)} on=${on.rms.toFixed(3)} (ratio ${ratio.toFixed(2)})`);
console.log(`REPULSION OK — particles push apart: pile RMS spread ${off.rms.toFixed(2)}m → ${on.rms.toFixed(2)}m (${ratio.toFixed(1)}x wider with repulsion)`);
