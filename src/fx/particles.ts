import * as THREE from "three";

const VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vLife = aLife;
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (320.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    gl_FragColor = vec4(vColor, soft * clamp(vLife, 0.0, 1.0));
  }
`;

export type ParticleKind = "dust" | "smoke" | "spark" | "debris" | "light";

export interface BurstOptions {
  count: number;
  color: THREE.ColorRepresentation;
  speed: number;
  spread?: number;
  size?: number;
  life?: number;
  /** vertical acceleration: negative = sinks (dust), positive = rises (smoke). */
  buoyancy?: number;
  /** 0..1 how strongly the wind drags the particle. */
  windCoupling?: number;
  /** GPU sink: fraction (0..1) of the emitter's particle slice to spawn. */
  strength?: number;
  /** GPU sink: behaviour/colour family. */
  kind?: ParticleKind;
  /** GPU sink: explicit colour-type code (0..1) overriding the kind default — lets debris carry
   *  its source material's colour (encoded inside the 0.6–0.8 "debris" band). */
  colorType?: number;
}

/** Implemented by both the CPU particle system and the GPU (GPGPU) system. */
export interface ParticleSink {
  burst(x: number, y: number, z: number, o: BurstOptions): void;
}

export class Particles {
  readonly points: THREE.Points;
  private readonly cap: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly buoy: Float32Array;
  private readonly damp: Float32Array;
  private readonly free: number[] = [];
  private readonly lifeAttr: THREE.BufferAttribute;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, capacity = 4000) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.buoy = new Float32Array(capacity);
    this.damp = new Float32Array(capacity);
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setAttribute("aLife", this.lifeAttr);
    geo.setAttribute("aSize", this.sizeAttr);
    geo.setDrawRange(0, capacity);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, vertexColors: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  burst(x: number, y: number, z: number, o: BurstOptions): void {
    const color = new THREE.Color(o.color);
    const spread = o.spread ?? 1;
    const size = o.size ?? 6;
    const life = o.life ?? 1.2;
    const buoy = o.buoyancy ?? -2;
    const damp = o.windCoupling ?? 0.6;
    for (let n = 0; n < o.count; n++) {
      const i = this.free.pop();
      if (i === undefined) return;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize().multiplyScalar(o.speed * (0.4 + Math.random() * 0.6));
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      const tint = 0.8 + Math.random() * 0.3;
      this.col[i * 3] = color.r * tint;
      this.col[i * 3 + 1] = color.g * tint;
      this.col[i * 3 + 2] = color.b * tint;
      this.vx[i] = dir.x;
      this.vy[i] = dir.y;
      this.vz[i] = dir.z;
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.maxLife[i] = life * (0.7 + Math.random() * 0.6);
      this.life[i] = this.maxLife[i];
      this.alpha[i] = 1;
      this.buoy[i] = buoy;
      this.damp[i] = damp;
    }
  }

  update(dt: number, wind: { x: number; y: number; z: number }): void {
    for (let i = 0; i < this.cap; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.free.push(i);
        continue;
      }
      this.life[i] = nl;
      this.alpha[i] = nl / this.maxLife[i];
      const k = this.damp[i] * dt;
      this.vx[i] += (wind.x - this.vx[i]) * k;
      this.vy[i] += (wind.y - this.vy[i]) * k + this.buoy[i] * dt;
      this.vz[i] += (wind.z - this.vz[i]) * k;
      this.pos[i * 3] += this.vx[i] * dt;
      this.pos[i * 3 + 1] += this.vy[i] * dt;
      this.pos[i * 3 + 2] += this.vz[i] * dt;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}
