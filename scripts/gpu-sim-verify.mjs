import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDevice } from "./lib/gpuRun.mjs";
import { GrainSim } from "../src/gpu/grainSim.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const k = (name) => readFileSync(join(root, "src/gpu/kernels", name), "utf8");
const shaders = {
  predict: k("predict.wgsl"), gridFill: k("gridFill.wgsl"), pbd: k("pbd.wgsl"),
  world: k("worldCollide.wgsl"), finalize: k("finalize.wgsl"), impulse: k("impulse.wgsl"),
};

const device = await getDevice();

const n = 2000;
const radius = 0.25;
// a moderately packed block dropped above the ground (spread over ~5 m to avoid
// pathological initial overlap; PBD then settles it into a pile)
const initial = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  initial[i * 3] = (Math.random() * 2 - 1) * 2.5;
  initial[i * 3 + 1] = 5 + (Math.random() * 2 - 1) * 2.5;
  initial[i * 3 + 2] = (Math.random() * 2 - 1) * 2.5;
}

const cfg = {
  count: n, cellSize: 0.5, origin: [-12, -2, -12], dim: [48, 24, 48],
  radius, maxPerCell: 32, gravity: -9.81, dt: 1 / 60, pbdIterations: 4,
  groundY: 0, stiffness: 0.3, damping: 0.04, bounds: [-8, 8, -8, 8],
};

const sim = new GrainSim(device, cfg, shaders, initial);

const xzExtent = (p) => {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.hypot(p[i * 3], p[i * 3 + 2]));
  return m;
};
const avgY = (p) => { let s = 0; for (let i = 0; i < n; i++) s += p[i * 3 + 1]; return s / n; };
const minY = (p) => { let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, p[i * 3 + 1]); return m; };

const spreadBefore = xzExtent(initial);
for (let s = 0; s < 250; s++) sim.step();
const p = await sim.readPositions();

let finite = true;
let contained = true;
for (let i = 0; i < n; i++) {
  const x = p[i * 3], z = p[i * 3 + 2];
  if (x < -8 - 0.01 || x > 8 + 0.01 || z < -8 - 0.01 || z > 8 + 0.01) { contained = false; break; }
}
for (let i = 0; i < n * 3; i++) if (!Number.isFinite(p[i])) { finite = false; break; }

const checks = [
  ["stable (no NaN/Inf)", finite],
  ["no floor tunneling (minY >= radius-0.05)", minY(p) >= radius - 0.05],
  ["settled into a pile (avgY dropped from 5)", avgY(p) < 3.0],
  ["contained inside the box bounds [-8,8]", contained],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(`  minY=${minY(p).toFixed(3)} avgY=${avgY(p).toFixed(2)} xzExtent ${spreadBefore.toFixed(2)}->${xzExtent(p).toFixed(2)}`);

const allOk = checks.every(([, ok]) => ok);
console.log(allOk ? "\nGPU-SIM OK" : "\nGPU-SIM FAIL");
process.exit(allOk ? 0 : 1);
