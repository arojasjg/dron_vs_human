// Device-agnostic GPU grain simulation (PBD): predict -> spatial grid -> contact
// solve -> finalize, all on the GPU. The same class runs under Dawn in Node (for
// headless verification) and under navigator.gpu in the browser (for rendering),
// because the WebGPU API is identical. Reuses the WGSL kernels verified in test:gpu.

// WebGPU usage flags are spec-fixed (not globals under Dawn/Node).
const STORAGE = 128, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, MAP_READ = 1, VERTEX = 32;

export interface GrainShaders {
  predict: string;
  gridFill: string;
  pbd: string;
  world: string;
  finalize: string;
  impulse: string;
}

export interface GrainConfig {
  count: number;
  cellSize: number;
  origin: [number, number, number];
  dim: [number, number, number];
  radius: number;
  maxPerCell: number;
  gravity: number;
  dt: number;
  pbdIterations: number;
  groundY: number;
  stiffness: number;
  damping: number;
  /** Box container bounds: [minX, maxX, minZ, maxZ]. */
  bounds: [number, number, number, number];
}

const WG = 64;

export class GrainSim {
  readonly cfg: GrainConfig;
  readonly posBuffer: GPUBuffer; // exposed so a renderer can read it as a vertex buffer
  private readonly device: GPUDevice;
  private readonly vel: GPUBuffer;
  private readonly predicted: GPUBuffer;
  private readonly scratch: GPUBuffer;
  private readonly cellCount: GPUBuffer;
  private readonly cellPos: GPUBuffer;
  private readonly uPredict: GPUBuffer;
  private readonly uGrid: GPUBuffer;
  private readonly uPbd: GPUBuffer;
  private readonly uWorld: GPUBuffer;
  private readonly uFinal: GPUBuffer;

  private readonly predictPipe: GPUComputePipeline;
  private readonly gridPipe: GPUComputePipeline;
  private readonly pbdPipe: GPUComputePipeline;
  private readonly worldPipe: GPUComputePipeline;
  private readonly finalPipe: GPUComputePipeline;
  private readonly impulsePipe: GPUComputePipeline;
  private readonly uImpulse: GPUBuffer;
  private readonly bindImpulse: GPUBindGroup;

  private readonly bindPredict: GPUBindGroup;
  private readonly bindGridPred: GPUBindGroup;
  private readonly bindGridScr: GPUBindGroup;
  private readonly bindPbdPS: GPUBindGroup; // predicted -> scratch
  private readonly bindPbdSP: GPUBindGroup; // scratch -> predicted
  private readonly bindWorldPred: GPUBindGroup;
  private readonly bindWorldScr: GPUBindGroup;
  private readonly bindFinalPred: GPUBindGroup;
  private readonly bindFinalScr: GPUBindGroup;

  constructor(device: GPUDevice, cfg: GrainConfig, shaders: GrainShaders, initialPos: Float32Array) {
    this.device = device;
    this.cfg = cfg;
    const n = cfg.count;
    const nc = cfg.dim[0] * cfg.dim[1] * cfg.dim[2];

    const storage = (data: Float32Array | Uint32Array, extra = 0) => {
      const buf = device.createBuffer({ size: data.byteLength, usage: STORAGE | COPY_SRC | COPY_DST | extra });
      device.queue.writeBuffer(buf, 0, data as unknown as GPUAllowSharedBufferSource);
      return buf;
    };
    this.posBuffer = storage(initialPos, VERTEX);
    this.vel = storage(new Float32Array(n * 3));
    this.predicted = storage(new Float32Array(n * 3));
    this.scratch = storage(new Float32Array(n * 3));
    this.cellCount = storage(new Uint32Array(nc));
    this.cellPos = storage(new Float32Array(nc * cfg.maxPerCell * 3));

    const uniform = (data: Float32Array) => {
      const buf = device.createBuffer({ size: data.byteLength, usage: UNIFORM | COPY_DST });
      device.queue.writeBuffer(buf, 0, data as unknown as GPUAllowSharedBufferSource);
      return buf;
    };
    const [ox, oy, oz] = cfg.origin;
    const [dx, dy, dz] = cfg.dim;
    const [bMinX, bMaxX, bMinZ, bMaxZ] = cfg.bounds;
    this.uPredict = uniform(new Float32Array([cfg.dt, cfg.gravity, n, 0]));
    this.uGrid = uniform(new Float32Array([cfg.cellSize, ox, oy, oz, dx, dy, dz, n, cfg.maxPerCell, 0, 0, 0]));
    this.uPbd = uniform(new Float32Array([cfg.cellSize, ox, oy, oz, dx, dy, dz, n, cfg.maxPerCell, cfg.radius, cfg.groundY, cfg.stiffness]));
    this.uWorld = uniform(new Float32Array([bMinX, bMaxX, bMinZ, bMaxZ, cfg.groundY, cfg.radius, n, 0]));
    this.uFinal = uniform(new Float32Array([cfg.dt, cfg.damping, n, 0]));

    const pipe = (code: string) =>
      device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    this.predictPipe = pipe(shaders.predict);
    this.gridPipe = pipe(shaders.gridFill);
    this.pbdPipe = pipe(shaders.pbd);
    this.worldPipe = pipe(shaders.world);
    this.finalPipe = pipe(shaders.finalize);
    this.impulsePipe = pipe(shaders.impulse);
    this.uImpulse = uniform(new Float32Array(8));

    const bg = (pipeline: GPUComputePipeline, bufs: GPUBuffer[]) =>
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bufs.map((buffer, i) => ({ binding: i, resource: { buffer } })) });
    this.bindPredict = bg(this.predictPipe, [this.posBuffer, this.vel, this.predicted, this.uPredict]);
    this.bindGridPred = bg(this.gridPipe, [this.predicted, this.cellCount, this.cellPos, this.uGrid]);
    this.bindGridScr = bg(this.gridPipe, [this.scratch, this.cellCount, this.cellPos, this.uGrid]);
    this.bindPbdPS = bg(this.pbdPipe, [this.predicted, this.cellCount, this.cellPos, this.scratch, this.uPbd]);
    this.bindPbdSP = bg(this.pbdPipe, [this.scratch, this.cellCount, this.cellPos, this.predicted, this.uPbd]);
    this.bindWorldPred = bg(this.worldPipe, [this.predicted, this.uWorld]);
    this.bindWorldScr = bg(this.worldPipe, [this.scratch, this.uWorld]);
    this.bindFinalPred = bg(this.finalPipe, [this.posBuffer, this.vel, this.predicted, this.uFinal]);
    this.bindFinalScr = bg(this.finalPipe, [this.posBuffer, this.vel, this.scratch, this.uFinal]);
    this.bindImpulse = bg(this.impulsePipe, [this.posBuffer, this.vel, this.uImpulse]);
  }

  /** Applies a radial explosion impulse to grain velocities (event, not per-step). */
  applyImpulse(cx: number, cy: number, cz: number, radius: number, strength: number): void {
    this.device.queue.writeBuffer(
      this.uImpulse, 0,
      new Float32Array([cx, cy, cz, radius, strength, this.cfg.count, 0, 0]) as unknown as GPUAllowSharedBufferSource,
    );
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.impulsePipe, this.bindImpulse);
    this.device.queue.submit([enc.finish()]);
  }

  private dispatch(enc: GPUCommandEncoder, pipeline: GPUComputePipeline, bind: GPUBindGroup): void {
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(this.cfg.count / WG));
    pass.end();
  }

  /** One simulation step. Records and submits all compute passes. */
  step(): void {
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.predictPipe, this.bindPredict);

    // Rebuild the grid from the CURRENT positions each iteration so a grain's own
    // stored position matches it (self is skipped by dist≈0) and neighbours are fresh.
    let inPredicted = true; // current positions are in `predicted`
    for (let k = 0; k < this.cfg.pbdIterations; k++) {
      enc.clearBuffer(this.cellCount);
      this.dispatch(enc, this.gridPipe, inPredicted ? this.bindGridPred : this.bindGridScr);
      this.dispatch(enc, this.pbdPipe, inPredicted ? this.bindPbdPS : this.bindPbdSP);
      inPredicted = !inPredicted;
    }
    this.dispatch(enc, this.worldPipe, inPredicted ? this.bindWorldPred : this.bindWorldScr);
    this.dispatch(enc, this.finalPipe, inPredicted ? this.bindFinalPred : this.bindFinalScr);
    this.device.queue.submit([enc.finish()]);
  }

  /** Reads the current positions back to the CPU (for headless verification). */
  async readPositions(): Promise<Float32Array> {
    const bytes = this.cfg.count * 3 * 4;
    const staging = this.device.createBuffer({ size: bytes, usage: COPY_DST | MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.posBuffer, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(MAP_READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return out;
  }
}
