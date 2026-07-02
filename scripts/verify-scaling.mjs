import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ARGS = ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=800,600"];

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ARGS });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

async function measure(ptex) {
  await page.goto(`http://localhost:5173/?ptex=${ptex}`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => window.__particles?.debugParticleMode?.().startsWith("gpu"), { timeout: 20000 });
  const mode = await page.evaluate(() => window.__particles.debugParticleMode());
  // warm up, then measure per-frame CPU bookkeeping cost
  await page.evaluate(() => window.__particles.debugTimeBookkeeping(5000));
  const ms = await page.evaluate(() => window.__particles.debugTimeBookkeeping(50000));
  return { mode, ms };
}

const small = await measure(256);   // 65,536 particles
const big = await measure(1024);    // 1,048,576 particles
await browser.close();

const ratioCapacity = (1024 * 1024) / (256 * 256); // 16x more particles
const ratioCost = big.ms / small.ms;
console.log(JSON.stringify({ small, big, ratioCapacity, ratioCost, pageErrors: errors }, null, 2));

const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (errors.length) fail("page errors");
if (!small.mode.endsWith("65536")) fail("small not 256^2");
if (!big.mode.endsWith("1048576")) fail("big not 1024^2");
// 16x more particles must NOT cost ~16x more CPU per frame — proves O(1) CPU (GPU does the work)
if (ratioCost > 3) fail(`CPU per-frame cost grew ${ratioCost.toFixed(2)}x for 16x particles — not O(1)`);
console.log(`SCALING OK — 16x more particles (65k→1.05M), per-frame CPU bookkeeping cost ratio ${ratioCost.toFixed(2)}x (≈O(1))`);
