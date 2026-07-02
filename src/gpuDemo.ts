import { GrainSim, type GrainConfig } from "./gpu/grainSim.ts";
import predictWgsl from "./gpu/kernels/predict.wgsl?raw";
import gridFillWgsl from "./gpu/kernels/gridFill.wgsl?raw";
import pbdWgsl from "./gpu/kernels/pbd.wgsl?raw";
import worldWgsl from "./gpu/kernels/worldCollide.wgsl?raw";
import finalizeWgsl from "./gpu/kernels/finalize.wgsl?raw";
import impulseWgsl from "./gpu/kernels/impulse.wgsl?raw";
import billboardWgsl from "./gpu/kernels/billboard.wgsl?raw";

// --- tiny column-major mat4 (WebGPU clip space, z in [0,1]) -----------------
type M4 = Float32Array;
function perspective(fovy: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]);
}
function lookAt(eye: number[], c: number[], up: number[]): M4 {
  const z = norm([eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]]);
  const x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// --- billboard quad (6 verts) — 6x cheaper than a cube, shaded as a sphere ----
function unitQuad(): Float32Array {
  return new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]); // corners in [-1,1]^2
}

const hud = document.getElementById("hud")!;
const fail = (m: string) => { const e = document.getElementById("err")!; e.style.display = "flex"; e.textContent = m; };

async function main() {
  if (!navigator.gpu) return fail("Tu navegador no expone WebGPU. Usa Chrome/Edge/Firefox recientes con WebGPU activado.");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return fail("No hay adaptador WebGPU disponible en este equipo.");
  // request the GPU's real limits so large grid buffers can bind
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  // surface async GPU validation errors on screen instead of failing silently
  device.addEventListener("uncapturederror", (e) => {
    const err = (e as GPUUncapturedErrorEvent).error;
    fail("WebGPU error: " + (err && "message" in err ? err.message : String(err)));
  });
  // a too-heavy frame can trip the OS GPU watchdog (TDR) -> device lost -> black screen
  device.lost.then((info) => {
    if (info.reason !== "destroyed") {
      fail("GPU perdida (" + info.reason + "): " + info.message +
        "\nProbablemente 'n' es demasiado alto para esta GPU (timeout del driver). Recarga con un n menor, p. ej. ?n=120000.");
    }
  });

  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();

  // cap N to avoid certain GPU-watchdog crashes; high counts are heavy for PBD collision
  const N = Math.min(Number(new URLSearchParams(location.search).get("n")) || 100000, 400000);
  const radius = 0.1;
  // grid sized so cellItems stays well under the storage-buffer limit; the domain
  // covers the drop height so grains never fall outside the grid.
  const cfg: GrainConfig = {
    count: N, cellSize: 0.3, origin: [-21, -1, -21], dim: [140, 64, 140],
    radius, maxPerCell: 8, gravity: -9.81, dt: 1 / 60, pbdIterations: 2,
    groundY: 0, stiffness: 0.4, damping: 0.04, bounds: [-19, 19, -19, 19],
  };

  const initial = new Float32Array(N * 3);
  const drop = () => {
    for (let i = 0; i < N; i++) {
      initial[i * 3] = (Math.random() * 2 - 1) * 9;
      initial[i * 3 + 1] = 6 + Math.random() * 9; // within the domain (y up to ~18)
      initial[i * 3 + 2] = (Math.random() * 2 - 1) * 9;
    }
    device.queue.writeBuffer(sim.posBuffer, 0, initial as unknown as GPUAllowSharedBufferSource);
  };
  const sim = new GrainSim(
    device, cfg,
    { predict: predictWgsl, gridFill: gridFillWgsl, pbd: pbdWgsl, world: worldWgsl, finalize: finalizeWgsl, impulse: impulseWgsl },
    initial,
  );
  drop();
  const blast = () => sim.applyImpulse(0, 1.5, 0, 7, 18);

  // render resources — instanced camera-facing billboards (6 verts), shaded as spheres
  const quad = unitQuad();
  const quadBuf = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(quadBuf, 0, quad as unknown as GPUAllowSharedBufferSource);
  const quadVertCount = quad.length / 2;
  const camBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); // view + proj

  const mod = device.createShaderModule({ code: billboardWgsl });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: mod, entryPoint: "vs",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
      ],
    },
    fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });
  const camBind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: camBuf } }] });

  let depth: GPUTexture | null = null;
  function resize() {
    const dpr = Math.min(devicePixelRatio, 1.5);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    ctx.configure({ device, format, alphaMode: "opaque" });
    depth?.destroy();
    depth = device.createTexture({ size: [canvas.width, canvas.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  addEventListener("resize", resize); resize();

  // orbit camera controls: drag = rotate, wheel = zoom; gentle auto-spin when idle
  const cam = { yaw: 0.6, pitch: 0.4, dist: 34 };
  let dragging = false, lastX = 0, lastY = 0, idle = true;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  canvas.addEventListener("mousedown", (e) => { if (e.button === 0) { dragging = true; idle = false; lastX = e.clientX; lastY = e.clientY; } });
  addEventListener("mouseup", () => { dragging = false; });
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    cam.yaw -= (e.clientX - lastX) * 0.005;
    cam.pitch = clamp(cam.pitch + (e.clientY - lastY) * 0.005, -0.2, 1.45);
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener("wheel", (e) => { cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 2, 8, 70); e.preventDefault(); }, { passive: false });
  addEventListener("keydown", (e) => { if (e.code === "Space") drop(); if (e.code === "KeyB") blast(); });
  canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); blast(); });

  let frames = 0, fps = 60, last = performance.now();
  function frame() {
    const now = performance.now(); const dt = (now - last) / 1000; last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

    sim.step();

    if (idle) cam.yaw += dt * 0.08; // slow auto-spin until the user grabs the camera
    const aspect = canvas.width / canvas.height;
    const cp = Math.cos(cam.pitch);
    const eye = [Math.cos(cam.yaw) * cp * cam.dist, Math.sin(cam.pitch) * cam.dist + 5, Math.sin(cam.yaw) * cp * cam.dist];
    const camData = new Float32Array(32);
    camData.set(lookAt(eye, [0, 3, 0], [0, 1, 0]), 0);
    camData.set(perspective(1.05, aspect, 0.1, 300), 16);
    device.queue.writeBuffer(camBuf, 0, camData as unknown as GPUAllowSharedBufferSource);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0.06, g: 0.07, b: 0.09, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, camBind);
    pass.setVertexBuffer(0, quadBuf);
    pass.setVertexBuffer(1, sim.posBuffer);
    pass.draw(quadVertCount, N);
    pass.end();
    device.queue.submit([enc.finish()]);

    if ((frames++ & 15) === 0) {
      hud.innerHTML = `<b>${(N / 1e3).toFixed(0)}k</b> granos GPU · física PBD en WebGPU · <b>${fps.toFixed(0)} fps</b><br>` +
        `arrastrar = girar · rueda = zoom · Espacio = soltar · clic der / B = explosión · ?n=500000`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => fail(String(e)));
