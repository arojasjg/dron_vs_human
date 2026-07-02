import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const gpu = require("@kmamal/gpu");

// WebGPU usage flags are spec-fixed bit values (not exposed as Node globals)
const BU = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128, UNIFORM: 64, INDIRECT: 256 };
const MAP_READ = 1;

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i < arrayLength(&data)) { data[i] = data[i] * 2.0; }
}`;

async function main() {
  const instance = gpu.create([]);
  const adapter = await instance.requestAdapter();
  if (!adapter) { console.log("PROBE: no adapter"); process.exit(2); }
  const device = await adapter.requestDevice();

  const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const n = input.length;
  const buf = device.createBuffer({ size: n * 4, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  device.queue.writeBuffer(buf, 0, input);

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();

  const staging = device.createBuffer({ size: n * 4, usage: BU.COPY_DST | BU.MAP_READ });
  enc.copyBufferToBuffer(buf, 0, staging, 0, n * 4);
  device.queue.submit([enc.finish()]);

  await staging.mapAsync(MAP_READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();

  const expected = input.map((v) => v * 2);
  const ok = out.every((v, i) => Math.abs(v - expected[i]) < 1e-5);
  let info = {};
  try { info = adapter.info || {}; } catch { /* */ }
  console.log("PROBE: adapter=" + (info.vendor || "?") + "/" + (info.architecture || "?") + " backend=" + (info.description || "?"));
  console.log("PROBE: compute result = [" + out.join(",") + "]  expected*2  => " + (ok ? "OK" : "MISMATCH"));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.log("PROBE: error " + String(e)); process.exit(3); });
