import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
// PTEX selects particle-texture size; small keeps software (SwiftShader) headless fast.
const PTEX = process.env.PTEX || "256";
const CAPONLY = process.env.SMOKE_CAPONLY === "1";
const URL = `http://localhost:5173/?ptex=${PTEX}`;

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--window-size=1280,800",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });

// wait for the loading overlay to disappear (Rapier init + first frame)
await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector("#app canvas"), { timeout: 20000 });

const canvas = await page.evaluate(() => {
  const c = document.querySelector("#app canvas");
  return c ? { w: c.width, h: c.height } : null;
});

const voxelsBefore = await page.evaluate(() => window.__particles?.debugVoxelCount?.() ?? -1);
const particleMode = await page.evaluate(() => window.__particles?.debugParticleMode?.() ?? "unknown");

await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: "scripts/shot-before.png" });

let voxelsAfter = voxelsBefore;
if (!CAPONLY) {
  // detonate the wall and the house, headlessly
  await page.evaluate(() => {
    const g = window.__particles;
    g.debugBlast(7.0, 1.6, 1.6, 2.6, 420); // wall
    g.debugBlast(2.0, 2.0, 1.0, 2.2, 360); // house front
  });
  await new Promise((r) => setTimeout(r, 2800));
  voxelsAfter = await page.evaluate(() => window.__particles?.debugVoxelCount?.() ?? -1);
  await page.screenshot({ path: "scripts/shot-after.png" });
}

await browser.close();

console.log(JSON.stringify({
  canvas,
  particleMode,
  capOnly: CAPONLY,
  voxelsBefore,
  voxelsAfter,
  removed: voxelsBefore - voxelsAfter,
  pageErrors: errors,
  consoleErrors,
}, null, 2));

if (errors.length > 0) {
  console.error("FAIL: page errors detected");
  process.exit(1);
}
if (!canvas || canvas.w === 0) {
  console.error("FAIL: no canvas rendered");
  process.exit(1);
}
if (!CAPONLY && voxelsAfter >= voxelsBefore) {
  console.error("FAIL: destruction did not remove voxels");
  process.exit(1);
}
console.log("SMOKE OK");
