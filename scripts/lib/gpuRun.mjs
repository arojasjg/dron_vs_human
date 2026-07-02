import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const gpu = require("@kmamal/gpu");

// WebGPU usage flags are spec-fixed bit values (not exposed as Node globals).
const BU = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128, UNIFORM: 64, INDIRECT: 256 };
const MAP_READ = 1;

let _device = null;
export async function getDevice() {
  if (_device) return _device;
  const instance = gpu.create([]);
  const adapter = await instance.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter (Dawn)");
  _device = await adapter.requestDevice();
  return _device;
}

/**
 * Runs a single compute pass. `buffers` are bound to @binding(0,1,2,...) in order.
 * Each: { data: TypedArray, usage?: 'storage'|'uniform', read?: boolean }.
 * Returns an array aligned with `buffers`; readback entries hold the result TypedArray.
 */
export async function runCompute({ code, entryPoint = "main", buffers, workgroups }) {
  const device = await getDevice();
  const wg = Array.isArray(workgroups) ? workgroups : [workgroups, 1, 1];

  const gpuBufs = buffers.map((b) => {
    const isUniform = b.usage === "uniform";
    const usage = (isUniform ? BU.UNIFORM : BU.STORAGE) | BU.COPY_DST | BU.COPY_SRC;
    const buf = device.createBuffer({ size: b.data.byteLength, usage });
    device.queue.writeBuffer(buf, 0, b.data);
    return buf;
  });

  const module = device.createShaderModule({ code });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint } });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: gpuBufs.map((buffer, i) => ({ binding: i, resource: { buffer } })),
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(wg[0], wg[1] ?? 1, wg[2] ?? 1);
  pass.end();

  const stagings = buffers.map((b, i) =>
    b.read ? device.createBuffer({ size: b.data.byteLength, usage: BU.COPY_DST | BU.MAP_READ }) : null);
  buffers.forEach((b, i) => { if (b.read) enc.copyBufferToBuffer(gpuBufs[i], 0, stagings[i], 0, b.data.byteLength); });
  device.queue.submit([enc.finish()]);

  const out = [];
  for (let i = 0; i < buffers.length; i++) {
    if (!buffers[i].read) { out.push(null); continue; }
    await stagings[i].mapAsync(MAP_READ);
    const Ctor = buffers[i].data.constructor;
    out.push(new Ctor(stagings[i].getMappedRange().slice(0)));
    stagings[i].unmap();
  }
  return out;
}

/**
 * Runs a multi-kernel pipeline over a shared, named set of buffers (each pass in its
 * own compute pass → storage writes are visible to the next). Returns an object with
 * the readback TypedArrays for every buffer marked `read`.
 *   buffers: { name: { data, usage?, read? } }
 *   passes:  [ { code, entryPoint?, binds: [name...], workgroups } ]
 */
export async function runPasses({ buffers, passes }) {
  const device = await getDevice();
  const gpuBufs = {};
  for (const [name, b] of Object.entries(buffers)) {
    const usage = (b.usage === "uniform" ? BU.UNIFORM : BU.STORAGE) | BU.COPY_DST | BU.COPY_SRC;
    const buf = device.createBuffer({ size: b.data.byteLength, usage });
    device.queue.writeBuffer(buf, 0, b.data);
    gpuBufs[name] = buf;
  }

  const enc = device.createCommandEncoder();
  for (const p of passes) {
    const module = device.createShaderModule({ code: p.code });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: p.entryPoint ?? "main" } });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: p.binds.map((name, i) => ({ binding: i, resource: { buffer: gpuBufs[name] } })),
    });
    const wg = Array.isArray(p.workgroups) ? p.workgroups : [p.workgroups, 1, 1];
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(wg[0], wg[1] ?? 1, wg[2] ?? 1);
    pass.end();
  }

  const stagings = {};
  for (const [name, b] of Object.entries(buffers)) {
    if (!b.read) continue;
    stagings[name] = device.createBuffer({ size: b.data.byteLength, usage: BU.COPY_DST | BU.MAP_READ });
    enc.copyBufferToBuffer(gpuBufs[name], 0, stagings[name], 0, b.data.byteLength);
  }
  device.queue.submit([enc.finish()]);

  const out = {};
  for (const [name, b] of Object.entries(buffers)) {
    if (!b.read) continue;
    await stagings[name].mapAsync(MAP_READ);
    const Ctor = b.data.constructor;
    out[name] = new Ctor(stagings[name].getMappedRange().slice(0));
    stagings[name].unmap();
  }
  return out;
}

/** Max abs difference between two numeric arrays. */
export function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
