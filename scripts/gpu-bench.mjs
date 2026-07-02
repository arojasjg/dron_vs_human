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
const counts = (process.env.BENCH_N ? [Number(process.env.BENCH_N)] : [50000, 100000, 200000]);

console.log("GrainSim GPU step benchmark (Dawn / real GPU). All passes fused in 1 command encoder.");
for (const n of counts) {
  const radius = 0.1;
  const cfg = {
    count: n, cellSize: 0.3, origin: [-18, -1, -18], dim: [120, 48, 120],
    radius, maxPerCell: 16, gravity: -9.81, dt: 1 / 60, pbdIterations: 3,
    groundY: 0, stiffness: 0.3, damping: 0.04, bounds: [-16, 16, -16, 16],
  };
  const initial = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    initial[i * 3] = (Math.random() * 2 - 1) * 12;
    initial[i * 3 + 1] = 8 + Math.random() * 12;
    initial[i * 3 + 2] = (Math.random() * 2 - 1) * 12;
  }
  const sim = new GrainSim(device, cfg, shaders, initial);

  for (let i = 0; i < 20; i++) sim.step();            // warm up
  await sim.readPositions();                          // sync
  const t0 = performance.now();
  const N = 60;
  for (let i = 0; i < N; i++) sim.step();
  await sim.readPositions();                          // force the queue to finish
  const ms = (performance.now() - t0) / N;
  console.log(`  ${(n / 1e6).toFixed(2)}M grains: ${ms.toFixed(2)} ms/step  (~${(1000 / ms).toFixed(0)} steps/s)`);
}
process.exit(0);
