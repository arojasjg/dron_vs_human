import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCompute, runPasses, maxAbsDiff } from "./lib/gpuRun.mjs";
import { integrate } from "../src/gpu/cpu/integrate.ts";
import { makeGrid, numCells, computeCellKeys } from "../src/gpu/cpu/neighborGrid.ts";
import { buildFixedGrid } from "../src/gpu/cpu/fixedGrid.ts";
import { pbdSolve } from "../src/gpu/cpu/pbdSolve.ts";
import { worldCollide } from "../src/gpu/cpu/worldCollide.ts";
import { applyImpulse } from "../src/gpu/cpu/impulse.ts";
import { mpmStep, mpmNumNodes } from "../src/gpu/cpu/mpm.ts";
import { cullLod } from "../src/gpu/cpu/cullLod.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kernel = (name) => readFileSync(join(root, "src/gpu/kernels", name), "utf8");

const rand = (n, s = 5) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * s;
  return a;
};

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "✓" : "✗"} ${name}: ${detail}`); };

// --- integrate: WGSL vs CPU twin ------------------------------------------
{
  const n = 2000;
  const pos = rand(n * 3), vel = rand(n * 3);
  const params = { dt: 1 / 60, gravity: -9.81, damping: 0.02, wind: [3, 0, 1.5], windCoupling: 0.4 };

  const cpuPos = pos.slice(), cpuVel = vel.slice();
  integrate(cpuPos, cpuVel, n, params);

  const P = new Float32Array([params.dt, params.gravity, params.damping, params.windCoupling, 3, 0, 1.5, n]);
  const [gpuPos, gpuVel] = await runCompute({
    code: kernel("integrate.wgsl"),
    buffers: [{ data: pos.slice(), read: true }, { data: vel.slice(), read: true }, { data: P, usage: "uniform" }],
    workgroups: Math.ceil(n / 64),
  });

  const dPos = maxAbsDiff(cpuPos, gpuPos), dVel = maxAbsDiff(cpuVel, gpuVel);
  check("integrate", dPos < 1e-4 && dVel < 1e-4, `maxDiff pos=${dPos.toExponential(2)} vel=${dVel.toExponential(2)}`);
}

// --- spatial-hash histogram (atomics): WGSL vs CPU twin -------------------
{
  const n = 5000;
  const pos = rand(n * 3, 9); // domain [-10,10]
  const g = makeGrid(1.0, [-10, -10, -10], [20, 20, 20]);
  const nc = numCells(g);

  const keys = computeCellKeys(g, pos, n);
  const cpuCounts = new Uint32Array(nc);
  for (let i = 0; i < n; i++) cpuCounts[keys[i]]++;

  const G = new Float32Array([g.cellSize, g.originX, g.originY, g.originZ, g.dimX, g.dimY, g.dimZ, n]);
  const [, gpuCounts] = await runCompute({
    code: kernel("cellHistogram.wgsl"),
    buffers: [{ data: pos.slice() }, { data: new Uint32Array(nc), read: true }, { data: G, usage: "uniform" }],
    workgroups: Math.ceil(n / 64),
  });

  const d = maxAbsDiff(cpuCounts, gpuCounts);
  const sum = gpuCounts.reduce((a, b) => a + b, 0);
  check("cellHistogram (atomics)", d === 0 && sum === n, `maxCountDiff=${d} total=${sum}/${n}`);
}

// --- fixed-capacity grid fill: WGSL vs CPU twin --------------------------
const GRID = makeGrid(1.0, [-10, -10, -10], [20, 20, 20]);
const NC = numCells(GRID);
const MAXPC = 32;

{
  const n = 4000;
  const pos = rand(n * 3, 9);
  const cpu = buildFixedGrid(GRID, pos, n, MAXPC);

  const G = new Float32Array([GRID.cellSize, GRID.originX, GRID.originY, GRID.originZ, GRID.dimX, GRID.dimY, GRID.dimZ, n, MAXPC, 0, 0, 0]);
  const out = await runPasses({
    buffers: {
      pos: { data: pos.slice() },
      cellCount: { data: new Uint32Array(NC), read: true },
      cellPos: { data: new Float32Array(NC * MAXPC * 3), read: true },
      G: { data: G, usage: "uniform" },
    },
    passes: [{ code: kernel("gridFill.wgsl"), binds: ["pos", "cellCount", "cellPos", "G"], workgroups: Math.ceil(n / 64) }],
  });

  // counts (the atomic histogram) must match exactly; every stored position must lie
  // in the cell it was written to (placement is also implied by the PBD check)
  const countsOk = maxAbsDiff(cpu.cellCount, out.cellCount) === 0;
  let placedOk = true;
  for (let c = 0; c < NC && placedOk; c++) {
    const k = Math.min(out.cellCount[c], MAXPC);
    for (let s = 0; s < k; s++) {
      const o = (c * MAXPC + s) * 3;
      const cell = computeCellKeys(GRID, out.cellPos.slice(o, o + 3), 1)[0];
      if (cell !== c) { placedOk = false; break; }
    }
  }
  check("gridFill (positions in cells)", countsOk && placedOk, `counts ${countsOk ? "match" : "DIFFER"}, placement ${placedOk ? "ok" : "WRONG"}`);
}

// --- PBD contact solve (1 iteration): WGSL vs CPU twin -------------------
{
  const n = 3000;
  const pos = rand(n * 3, 7);
  const radius = 0.5, groundY = 0, stiffness = 1;

  const cpuPos = pos.slice();
  pbdSolve(GRID, cpuPos, n, { radius, iterations: 1, groundY, stiffness });

  const G = new Float32Array([GRID.cellSize, GRID.originX, GRID.originY, GRID.originZ, GRID.dimX, GRID.dimY, GRID.dimZ, n, MAXPC, 0, 0, 0]);
  const P = new Float32Array([GRID.cellSize, GRID.originX, GRID.originY, GRID.originZ, GRID.dimX, GRID.dimY, GRID.dimZ, n, MAXPC, radius, groundY, stiffness]);
  const out = await runPasses({
    buffers: {
      pos: { data: pos.slice() },
      cellCount: { data: new Uint32Array(NC) },
      cellPos: { data: new Float32Array(NC * MAXPC * 3) },
      posOut: { data: new Float32Array(n * 3), read: true },
      G: { data: G, usage: "uniform" },
      P: { data: P, usage: "uniform" },
    },
    passes: [
      { code: kernel("gridFill.wgsl"), binds: ["pos", "cellCount", "cellPos", "G"], workgroups: Math.ceil(n / 64) },
      { code: kernel("pbd.wgsl"), binds: ["pos", "cellCount", "cellPos", "posOut", "P"], workgroups: Math.ceil(n / 64) },
    ],
  });

  const d = maxAbsDiff(cpuPos, out.posOut);
  check("pbd (1 iteration)", d < 1e-3, `maxPosDiff=${d.toExponential(2)}`);
}

// --- world (box container) collision: WGSL vs CPU twin ------------------
{
  const n = 4000;
  const pos = rand(n * 3, 14); // many out of bounds
  const w = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, groundY: 0, radius: 0.25 };

  const cpuPos = pos.slice();
  worldCollide(cpuPos, n, w);

  const W = new Float32Array([w.minX, w.maxX, w.minZ, w.maxZ, w.groundY, w.radius, n, 0]);
  const [gpuPos] = await runCompute({
    code: kernel("worldCollide.wgsl"),
    buffers: [{ data: pos.slice(), read: true }, { data: W, usage: "uniform" }],
    workgroups: Math.ceil(n / 64),
  });

  const d = maxAbsDiff(cpuPos, gpuPos);
  check("worldCollide (container)", d < 1e-5, `maxPosDiff=${d.toExponential(2)}`);
}

// --- explosion impulse: WGSL vs CPU twin --------------------------------
{
  const n = 4000;
  const pos = rand(n * 3, 6);
  const vel = rand(n * 3, 1);
  const imp = { center: [0, 0, 0], radius: 4, strength: 10 };

  const cpuVel = vel.slice();
  applyImpulse(pos, cpuVel, n, imp);

  const I = new Float32Array([0, 0, 0, imp.radius, imp.strength, n, 0, 0]);
  const [, gpuVel] = await runCompute({
    code: kernel("impulse.wgsl"),
    buffers: [{ data: pos.slice() }, { data: vel.slice(), read: true }, { data: I, usage: "uniform" }],
    workgroups: Math.ceil(n / 64),
  });

  const d = maxAbsDiff(cpuVel, gpuVel);
  check("impulse (explosion)", d < 1e-4, `maxVelDiff=${d.toExponential(2)}`);
}

// --- MLS-MPM one step (3 GPU kernels): WGSL vs CPU twin ------------------
{
  const g = { dx: 1, invDx: 1, ox: 0, oy: 0, oz: 0, dimX: 16, dimY: 16, dimZ: 16, dt: 0.002, gravity: -9.8, mass: 1, vol: 1, E: 50 };
  const nn = mpmNumNodes(g);
  const n = 200;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), C = new Float32Array(n * 9), J = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = 6 + Math.random() * 4; pos[i * 3 + 1] = 6 + Math.random() * 4; pos[i * 3 + 2] = 6 + Math.random() * 4;
    vel[i * 3] = (Math.random() - 0.5) * 0.5; vel[i * 3 + 1] = (Math.random() - 0.5) * 0.5; vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
  }
  // CPU twin
  const cP = pos.slice(), cV = vel.slice(), cC = C.slice(), cJ = J.slice();
  mpmStep(g, cP, cV, cC, cJ, n, new Float32Array(nn), new Float32Array(nn * 3));

  // GPU: 3 passes (zeroed atomic grids = cleared)
  const scale = 1e5;
  const MG = new Float32Array([g.dx, g.invDx, g.ox, g.oy, g.oz, g.dimX, g.dimY, g.dimZ, g.dt, g.gravity, g.mass, g.vol, g.E, scale, n, 0]);
  const out = await runPasses({
    buffers: {
      pos: { data: pos.slice(), read: true }, vel: { data: vel.slice(), read: true },
      Cm: { data: C.slice() }, Jp: { data: J.slice(), read: true },
      gMass: { data: new Int32Array(nn) }, gVelI: { data: new Int32Array(nn * 3) }, gVelF: { data: new Float32Array(nn * 3) },
      MG: { data: MG, usage: "uniform" },
    },
    passes: [
      { code: kernel("mpmP2G.wgsl"), binds: ["pos", "vel", "Cm", "Jp", "gMass", "gVelI", "MG"], workgroups: Math.ceil(n / 64) },
      { code: kernel("mpmGridUpdate.wgsl"), binds: ["gMass", "gVelI", "gVelF", "MG"], workgroups: Math.ceil(nn / 64) },
      { code: kernel("mpmG2P.wgsl"), binds: ["pos", "vel", "Cm", "Jp", "gVelF", "MG"], workgroups: Math.ceil(n / 64) },
    ],
  });

  const dP = maxAbsDiff(cP, out.pos), dV = maxAbsDiff(cV, out.vel), dJ = maxAbsDiff(cJ, out.Jp);
  check("MLS-MPM step", dP < 1e-3 && dV < 1e-2 && dJ < 1e-3, `pos=${dP.toExponential(2)} vel=${dV.toExponential(2)} J=${dJ.toExponential(2)}`);
}

// --- GPU-driven culling + LOD + compaction: WGSL vs CPU twin ------------
{
  const n = 6000;
  const pos = rand(n * 3, 9);
  const planes = new Float32Array([1, 0, 0, 4, -1, 0, 0, 4, 0, 1, 0, 4, 0, -1, 0, 4, 0, 0, 1, 4, 0, 0, -1, 4]);
  const params = { planes, cam: [0, 0, 20], lodNear: 8, lodFar: 18, radius: 0.2 };

  const cpu = cullLod(pos, n, params);

  const P = new Float32Array([0, 0, 20, params.lodNear, params.lodFar, params.radius, n, 0]);
  const out = await runPasses({
    buffers: {
      pos: { data: pos.slice() },
      planes: { data: planes },
      counter: { data: new Uint32Array(1), read: true },
      idx: { data: new Uint32Array(n), read: true },
      lod: { data: new Uint32Array(n), read: true },
      P: { data: P, usage: "uniform" },
    },
    passes: [{ code: kernel("cullLod.wgsl"), binds: ["pos", "planes", "counter", "idx", "lod", "P"], workgroups: Math.ceil(n / 64) }],
  });

  const gpuCount = out.counter[0];
  const gpuVisible = new Set([...out.idx.slice(0, gpuCount)]);
  const cpuVisible = new Set([...cpu.indices]);
  let setsMatch = gpuCount === cpu.count && gpuVisible.size === cpuVisible.size;
  if (setsMatch) for (const v of cpuVisible) if (!gpuVisible.has(v)) { setsMatch = false; break; }
  check("cullLod (frustum + LOD + compaction)", setsMatch, `count gpu=${gpuCount} cpu=${cpu.count}, sets ${setsMatch ? "match" : "DIFFER"}`);
}

const allOk = results.every((r) => r.pass);
console.log(allOk ? "\nGPU-VERIFY OK" : "\nGPU-VERIFY FAIL");
process.exit(allOk ? 0 : 1);
