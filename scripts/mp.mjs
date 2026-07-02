import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://localhost:5173/?mode=vs&room=mptest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn("node", ["server/relay.mjs"], { stdio: "inherit" });
await sleep(900);

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: false,
  args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-webgl", "--window-size=1200,800",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion"],
});
const errors = [];
const mk = async () => {
  const p = await browser.newPage();
  await p.setViewport({ width: 1100, height: 720 });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(URL, { waitUntil: "domcontentloaded", timeout: 40000 });
  await p.waitForFunction(() => !!window.__particles, { timeout: 30000 });
  return p;
};
const A = await mk();
const B = await mk();
await sleep(2000); // connect + build seeded world

const connected = {
  A: await A.evaluate(() => window.__particles.debugNetConnected()),
  B: await B.evaluate(() => window.__particles.debugNetConnected()),
};

// (0) Each player should spawn at a different one of the 4 points.
const spawns = {
  A: await A.evaluate(() => { const p = window.__particles.player.camera.position; return { x: +p.x.toFixed(1), z: +p.z.toFixed(1) }; }),
  B: await B.evaluate(() => { const p = window.__particles.player.camera.position; return { x: +p.x.toFixed(1), z: +p.z.toFixed(1) }; }),
};

// (1) Same seeded world → identical voxel count on both clients.
const world0 = {
  A: await A.evaluate(() => window.__particles.debugVoxelCount()),
  B: await B.evaluate(() => window.__particles.debugVoxelCount()),
};

// (2) Authoritative explosion on A → B carves identically. Both settle synchronously (debugSettle
// bypasses the background-tab rAF throttle), so the final voxel counts must match exactly.
await A.evaluate(() => { window.__particles.debugExplodeNet(3.75, 8, 6.25, 3.4, 520); window.__particles.debugSettle(); });
await sleep(600); // let B receive the broadcast over the WebSocket
await B.evaluate(() => window.__particles.debugSettle());
await sleep(200);
const world1 = {
  A: await A.evaluate(() => window.__particles.debugVoxelCount()),
  B: await B.evaluate(() => window.__particles.debugVoxelCount()),
};

// NOTE: a backgrounded tab throttles its render loop, so only the FOREGROUND tab broadcasts. A
// backgrounded tab still RECEIVES over the WebSocket, so we verify each direction by putting the
// sender in front. On two real machines both are foreground and sync runs both ways at once.

// A→B: A in front (broadcasts); B (background) receives. Fly A up → B's copy of A should rise.
await A.bringToFront(); await sleep(1500);
const bSeesA_before = await B.evaluate(() => window.__particles.debugRemoteCount());
const posBefore = await B.evaluate(() => window.__particles.debugRemotePos());
await A.keyboard.down("Space"); await sleep(1100); await A.keyboard.up("Space");
await sleep(900);
const bSeesA_after = await B.evaluate(() => window.__particles.debugRemoteCount());
const posAfter = await B.evaluate(() => window.__particles.debugRemotePos());

// B→A: B in front (broadcasts); A sees it.
await B.bringToFront(); await sleep(1500);
const aSeesB = await A.evaluate(() => window.__particles.debugRemoteCount());

// VS damage: blast next to A's own drone drops its HP.
await A.bringToFront(); await sleep(300);
const hpBefore = await A.evaluate(() => window.__particles.debugHp());
await A.evaluate(() => { const p = window.__particles.player.camera.position; window.__particles.debugBlast(p.x + 1.4, p.y, p.z, 2.4, 360); });
await sleep(200);
const hpAfter = await A.evaluate(() => window.__particles.debugHp());

relay.kill();
await browser.close();
console.log(JSON.stringify({
  connected,
  spawns: { ...spawns, separate: spawns.A.x !== spawns.B.x || spawns.A.z !== spawns.B.z },
  worldSync: { A: world0.A, B: world0.B, identical: world0.A === world0.B },
  carveSync: {
    A: world1.A, B: world1.B, identical: world1.A === world1.B,
    aRemoved: world0.A - world1.A, bRemoved: world0.B - world1.B,
  },
  aSeesB,
  bSeesA: { before: bSeesA_before, after: bSeesA_after },
  posSync: { before: posBefore, after: posAfter, roseBy: posAfter && posBefore ? +(posAfter.y - posBefore.y).toFixed(2) : null },
  vsDamage: { hpBefore, hpAfter, lost: hpBefore - hpAfter },
  errors,
}, null, 2));
