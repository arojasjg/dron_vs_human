import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = `http://localhost:5173/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vox = () => page.evaluate(() => window.__particles.debugVoxelCount());
const rockets = () => page.evaluate(() => window.__particles.debugRocketCount());

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

// 1) FLOOR HIT (the bounce case): fire down at the floor → must detonate on contact, not bounce
const v0 = await vox();
await page.evaluate(() => window.__particles.debugLaunchRocketAim(0.25, -0.7, 0.66));
await sleep(2000);
const floor = { destroyed: v0 - (await vox()), rocketsLeft: await rockets() };

// 2) STRUCTURE HIT: fire level into the lobby
const v1 = await vox();
await page.evaluate(() => window.__particles.debugLaunchRocket());
await sleep(2000);
const wall = { destroyed: v1 - (await vox()), rocketsLeft: await rockets() };

// 3) CHAIN: a blast at the camera reaches a fresh missile (0.6m ahead) → cooks it off
const chain = await page.evaluate(() => {
  const g = window.__particles;
  g.debugLaunchRocket();
  const before = g.debugRocketCount();
  const c = g.player.camera.position;
  g.debugBlast(c.x, c.y, c.z, 2.2, 360);
  return { before, after: g.debugRocketCount() };
});

await browser.close();
console.log(JSON.stringify({ floor, wall, chain, errors }, null, 2));
