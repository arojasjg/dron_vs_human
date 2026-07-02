import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu"],
});
const p = await b.newPage();
const logs = [], errs = [];
p.on("console", (m) => { if (m.text().includes("[capabilities]")) logs.push(m.text()); });
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto("http://localhost:5173/?ptex=256", { waitUntil: "networkidle2", timeout: 30000 });
await p.waitForFunction(() => window.__particles?.debugParticleMode?.(), { timeout: 20000 });
const hasGpuApi = await p.evaluate(() => "gpu" in navigator);
await new Promise((r) => setTimeout(r, 600));
await b.close();
console.log(JSON.stringify({ hasNavigatorGpu: hasGpuApi, capabilityLogs: logs, pageErrors: errs }, null, 2));
if (errs.length) { console.error("FAIL: page errors"); process.exit(1); }
if (logs.length === 0) { console.error("FAIL: capability detection did not log"); process.exit(1); }
console.log("CAPS OK");
