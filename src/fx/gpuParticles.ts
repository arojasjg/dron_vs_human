import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/addons/misc/GPUComputationRenderer.js";
import { VOXEL } from "../config";
import type { BurstOptions, ParticleKind, ParticleSink } from "./particles";
import { idleGate } from "./idleGate";

const EMITTERS = 24;

const COLOR_TYPE: Record<ParticleKind, number> = {
  dust: 0.1, smoke: 0.3, spark: 0.5, debris: 0.7, light: 0.9,
};

const COMMON = /* glsl */ `
  uniform float uTime;
  uniform float uDt;
  uniform vec3 uWind;
  uniform vec4 uEPos[${EMITTERS}];    // xyz = position, w = random seed
  uniform vec4 uEParams[${EMITTERS}]; // x = speed, y = life, z = strength(armed), w = colorType
  uniform sampler2D uHeightTex;
  uniform vec2 uHFOrigin;
  uniform vec2 uHFInvSize;
  uniform sampler2D uDensityTex;
  uniform vec2 uDensOrigin;
  uniform vec2 uDensInvSize;
  uniform float uRepel;

  float surfaceAt(vec2 xz){
    vec2 huv = (xz - uHFOrigin) * uHFInvSize;
    if (huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0) return 0.0;
    return max(texture2D(uHeightTex, huv).r, 0.0);
  }

  float hash11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  int emitterFor(float id){ return int(mod(id, float(${EMITTERS}))); }
  bool decideSpawn(float id, int e){
    vec4 par = uEParams[e];
    return par.z > 0.0 && hash11(id*1.7 + uEPos[e].w*131.0) < par.z;
  }
  float buoyancyOf(float ct){
    if (ct < 0.2) return -1.5;   // dust drifts down slowly
    if (ct < 0.4) return  2.4;   // smoke rises
    if (ct < 0.6) return -3.0;   // sparks
    if (ct < 0.8) return -9.2;   // fine debris falls
    return -1.0;
  }
  float windCouplingOf(float ct){
    if (ct < 0.2) return 0.9;
    if (ct < 0.4) return 0.45;   // smoke: drifts only gently
    if (ct < 0.6) return 0.25;
    if (ct < 0.8) return 0.3;
    return 0.8;
  }
  // Air particles AND falling debris ignore the per-column height-field and only respect the
  // ground. The height-field holds each column's MAX height (the roof), so using it would pin a
  // blast's dust/sparks/debris to the top of the building instead of letting them rain down to
  // the floor. (ct >= 0.8 "light" still uses it, but is unused.)
  bool ignoresSurface(float ct){ return ct < 0.8; }
`;

const VELOCITY_SHADER = COMMON + /* glsl */ `
  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 vel = texture2D(textureVelocity, uv);
    vec4 pos = texture2D(texturePosition, uv);
    float id = floor(gl_FragCoord.y)*resolution.x + floor(gl_FragCoord.x);
    int e = emitterFor(id);
    if (decideSpawn(id, e)){
      vec4 par = uEParams[e];
      float seed = uEPos[e].w;
      float a = hash11(id*3.1 + seed)*6.2831853;
      float u = hash11(id*5.7 + seed);
      float r = sqrt(max(0.0, 1.0 - u*u));
      vec3 dir = normalize(vec3(r*cos(a), 0.35 + 0.65*u, r*sin(a)));
      float spd = par.x*(0.35 + 0.9*hash11(id*9.1 + seed));
      gl_FragColor = vec4(dir*spd, par.w);
      return;
    }
    if (pos.w <= 0.0){ gl_FragColor = vel; return; }
    float ct = vel.w;
    vec3 v = vel.xyz;
    v += (uWind - v) * (windCouplingOf(ct) * uDt);
    v.y += buoyancyOf(ct) * uDt;
    // particle-particle repulsion: push down the density gradient (dense -> sparse)
    if (uRepel > 0.5) {
      vec2 duv = (pos.xz - uDensOrigin) * uDensInvSize;
      if (duv.x > 0.02 && duv.x < 0.98 && duv.y > 0.02 && duv.y < 0.98) {
        float o = 1.0 / 128.0;
        float gx = texture2D(uDensityTex, duv + vec2(o, 0.0)).r - texture2D(uDensityTex, duv - vec2(o, 0.0)).r;
        float gz = texture2D(uDensityTex, duv + vec2(0.0, o)).r - texture2D(uDensityTex, duv - vec2(0.0, o)).r;
        float gmag = length(vec2(gx, gz));
        if (gmag > 0.5) {
          vec2 dir = -vec2(gx, gz) / gmag;
          v.xz += dir * min(gmag * 0.025, 4.5) * uDt;
        }
      }
    }
    // rest on the world surface: stop downward motion + ground friction
    float surf = ignoresSurface(ct) ? 0.0 : surfaceAt(pos.xz);
    if (pos.y <= surf + 0.02){
      if (v.y < 0.0) v.y = 0.0;
      v.xz *= 0.86;
    }
    gl_FragColor = vec4(v, ct);
  }
`;

const POSITION_SHADER = COMMON + /* glsl */ `
  void main(){
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);
    float id = floor(gl_FragCoord.y)*resolution.x + floor(gl_FragCoord.x);
    int e = emitterFor(id);
    if (decideSpawn(id, e)){
      vec4 ep = uEPos[e];
      vec4 par = uEParams[e];
      float spread = 0.25 + par.x*0.02;
      vec3 off = (vec3(hash11(id*2.3+ep.w), hash11(id*4.9+ep.w), hash11(id*8.7+ep.w)) - 0.5) * spread;
      gl_FragColor = vec4(ep.xyz + off, par.y);
      return;
    }
    float life = pos.w;
    if (life <= 0.0){ gl_FragColor = vec4(pos.xyz, 0.0); return; }
    vec3 p = pos.xyz + vel.xyz * uDt;
    float ct = vel.w;
    float surf = ignoresSurface(ct) ? 0.0 : surfaceAt(p.xz);   // smoke: ground only
    if (p.y < surf) p.y = surf;
    gl_FragColor = vec4(p, life - uDt);
  }
`;

const RENDER_VERT = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform sampler2D uVelTex;
  attribute vec2 aRef;
  varying float vLife;
  varying float vType;
  float sizeOf(float ct){
    if (ct < 0.2) return 9.0;
    if (ct < 0.4) return 16.0;
    if (ct < 0.6) return 6.0;
    if (ct < 0.8) return 7.0;
    return 11.0;
  }
  void main(){
    vec4 P = texture2D(uPosTex, aRef);
    vec4 V = texture2D(uVelTex, aRef);
    vLife = P.w;
    vType = V.w;
    vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
    gl_PointSize = (P.w > 0.0 ? sizeOf(V.w) : 0.0) * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const DEBRIS_COLOR = /* glsl */ `
  // debris band (0.6–0.8) is sub-divided so each fragment keeps its source material's colour
  vec3 debrisColor(float ct){
    if (ct < 0.63) return vec3(0.56, 0.56, 0.58); // concrete
    if (ct < 0.67) return vec3(0.62, 0.30, 0.22); // brick
    if (ct < 0.71) return vec3(0.50, 0.34, 0.18); // wood
    if (ct < 0.75) return vec3(0.42, 0.44, 0.47); // metal
    return vec3(0.70, 0.80, 0.85);                // glass
  }
`;

const RENDER_FRAG = DEBRIS_COLOR + /* glsl */ `
  varying float vLife;
  varying float vType;
  vec3 colorOf(float ct){
    if (ct < 0.2) return vec3(0.78, 0.70, 0.58); // dust
    if (ct < 0.4) return vec3(0.22, 0.22, 0.24); // smoke
    if (ct < 0.6) return vec3(1.0, 0.62, 0.22);  // spark
    if (ct < 0.8) return debrisColor(ct);        // debris (per material)
    return vec3(0.85, 0.85, 0.88);
  }
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    vec3 base = colorOf(vType);
    if (vType >= 0.2 && vType < 0.4){
      // SMOKE: shade the disc as a pseudo-sphere (fake normal from the point coord) → a lit volumetric
      // puff with a dark core and a warm-lit rim, instead of a flat grey circle.
      vec3 n = normalize(vec3(d * 2.0, sqrt(max(0.0, 1.0 - r2 * 4.0))));
      float lit = 0.4 + 0.6 * max(0.0, dot(n, normalize(vec3(0.4, 0.75, 0.5))));
      base = mix(vec3(0.12, 0.12, 0.14), vec3(0.52, 0.49, 0.43), lit);
    } else if (vType >= 0.4 && vType < 0.6){
      // SPARK: a white-hot core fading to orange at the rim → reads as a glowing ember (LDR-safe).
      base = mix(vec3(1.0, 0.55, 0.12), vec3(1.0, 0.96, 0.75), smoothstep(0.16, 0.0, r2));
    }
    float a = clamp(vLife*1.6, 0.0, 1.0) * smoothstep(0.25, 0.0, r2);
    gl_FragColor = vec4(base, a);
  }
`;

// LOD cube layer: nearby particles are drawn as solid shaded cubes so they read as objects.
const CUBE_VERT = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform sampler2D uVelTex;
  uniform float uNear;
  attribute vec2 aRef;
  varying float vType;
  varying vec3 vNormalW;
  varying float vVisible;
  void main(){
    vec4 P = texture2D(uPosTex, aRef);
    vec4 V = texture2D(uVelTex, aRef);
    float dist = distance(P.xyz, cameraPosition);
    // only solid debris fragments become cubes — smoke/dust/sparks stay soft points
    float solid = (V.w > 0.6 && V.w < 0.8) ? 1.0 : 0.0;
    vVisible = (P.w > 0.0 && dist < uNear) ? solid : 0.0;
    vType = V.w;
    vNormalW = normal;
    vec3 world = P.xyz + position * vVisible;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const CUBE_FRAG = DEBRIS_COLOR + /* glsl */ `
  varying float vType;
  varying vec3 vNormalW;
  varying float vVisible;
  vec3 colorOf(float ct){
    if (ct < 0.2) return vec3(0.78, 0.70, 0.58);
    if (ct < 0.4) return vec3(0.22, 0.22, 0.24);
    if (ct < 0.6) return vec3(1.0, 0.62, 0.22);
    if (ct < 0.8) return debrisColor(ct);
    return vec3(0.85, 0.85, 0.88);
  }
  void main(){
    if (vVisible < 0.5) discard;
    vec3 L = normalize(vec3(0.5, 0.85, 0.35));
    float shade = 0.4 + 0.6 * max(0.0, dot(normalize(vNormalW), L));
    gl_FragColor = vec4(colorOf(vType) * shade, 1.0);
  }
`;

// Density pass: splats live particles additively into a top-down (XZ) grid so the
// simulation can read local crowding and push particles apart (cheap pseudo-collision).
const DENSITY_VERT = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform vec2 uDensOrigin;
  uniform vec2 uDensInvSize;
  attribute vec2 aRef;
  void main(){
    vec4 P = texture2D(uPosTex, aRef);
    if (P.w <= 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vec2 duv = (P.xz - uDensOrigin) * uDensInvSize;
    gl_Position = vec4(duv * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
  }
`;

const DENSITY_FRAG = /* glsl */ `
  void main(){ gl_FragColor = vec4(1.0); }
`;

/** GPU (GPGPU) particle system. All simulation lives in float textures on the GPU. */
export class GpuParticles implements ParticleSink {
  readonly capacity: number;
  /** 0..1 global emission throttle set by the perf governor — under load we spawn fewer particles
   *  per burst so a detonation storm can't spike a weak/integrated GPU. */
  emissionScale = 1;
  readonly points: THREE.Points;
  private cubes!: THREE.Mesh;
  /** Game time until which particles may still be alive. While idle (time past this), the whole GPU
   *  particle pipeline — density splat, the compute passes, and the two draw layers — is skipped, so
   *  an empty scene costs nothing on the GPU instead of always simulating+drawing the full buffer. */
  private aliveUntil = 0;
  private readonly gpu: GPUComputationRenderer;
  private readonly posVar: Variable;
  private readonly velVar: Variable;
  private readonly renderUniforms: { uPosTex: { value: THREE.Texture | null }; uVelTex: { value: THREE.Texture | null } };
  private readonly cubeUniforms: { uPosTex: { value: THREE.Texture | null }; uVelTex: { value: THREE.Texture | null }; uNear: { value: number } };
  private readonly cubeCount: number;
  private readonly densityRT: THREE.WebGLRenderTarget;
  private readonly densityScene: THREE.Scene;
  private readonly densityCam: THREE.Camera;
  private readonly densityUniforms: { uPosTex: { value: THREE.Texture | null }; uDensOrigin: { value: THREE.Vector2 }; uDensInvSize: { value: THREE.Vector2 } };
  private readonly ePos: THREE.Vector4[] = [];
  private readonly eParams: THREE.Vector4[] = [];
  private cursor = 0;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly texSize: number;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, texSize = 512) {
    this.renderer = renderer;
    // Clamp the buffer size: a detonation chain can bring almost the entire buffer
    // live in a single frame, so an oversized buffer is what spikes the GPU into a
    // driver timeout (TDR). 1024² (~1M) is opt-in only via ?ptex.
    texSize = Math.max(64, Math.min(1024, Math.floor(texSize)));
    this.texSize = texSize;
    this.capacity = texSize * texSize;
    this.gpu = new GPUComputationRenderer(texSize, texSize, renderer);

    const pos0 = this.gpu.createTexture();
    const vel0 = this.gpu.createTexture();
    // everything starts dead (life = pos.w = 0)
    (pos0.image.data as unknown as Float32Array).fill(0);
    (vel0.image.data as unknown as Float32Array).fill(0);

    this.velVar = this.gpu.addVariable("textureVelocity", VELOCITY_SHADER, vel0);
    this.posVar = this.gpu.addVariable("texturePosition", POSITION_SHADER, pos0);
    this.gpu.setVariableDependencies(this.velVar, [this.velVar, this.posVar]);
    this.gpu.setVariableDependencies(this.posVar, [this.velVar, this.posVar]);

    for (let i = 0; i < EMITTERS; i++) {
      this.ePos.push(new THREE.Vector4(0, 0, 0, 0));
      this.eParams.push(new THREE.Vector4(0, 0, 0, 0));
    }
    // placeholder height field (height 0 everywhere) until the real one is supplied
    const ph = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    ph.needsUpdate = true;

    // share the SAME uniform arrays across both compute materials
    for (const v of [this.velVar, this.posVar]) {
      v.material.uniforms.uTime = { value: 0 };
      v.material.uniforms.uDt = { value: 0 };
      v.material.uniforms.uWind = { value: new THREE.Vector3() };
      v.material.uniforms.uEPos = { value: this.ePos };
      v.material.uniforms.uEParams = { value: this.eParams };
      v.material.uniforms.uHeightTex = { value: ph };
      v.material.uniforms.uHFOrigin = { value: new THREE.Vector2(0, 0) };
      v.material.uniforms.uHFInvSize = { value: new THREE.Vector2(1, 1) };
      v.material.uniforms.uDensityTex = { value: ph };
      v.material.uniforms.uDensOrigin = { value: new THREE.Vector2(0, 0) };
      v.material.uniforms.uDensInvSize = { value: new THREE.Vector2(1, 1) };
      v.material.uniforms.uRepel = { value: 1 };
    }

    const error = this.gpu.init();
    if (error !== null) throw new Error("GPUComputationRenderer: " + error);

    // render layer
    const n = this.capacity;
    const refs = new Float32Array(n * 2);
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      refs[i * 2] = ((i % texSize) + 0.5) / texSize;
      refs[i * 2 + 1] = (Math.floor(i / texSize) + 0.5) / texSize;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
    geo.setDrawRange(0, n);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.renderUniforms = { uPosTex: { value: null }, uVelTex: { value: null } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.renderUniforms,
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // LOD cube layer — a budget of solid cubes drawn for the nearest particles
    const K = Math.min(n, 16000);
    this.cubeCount = K;
    const box = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
    const cg = new THREE.InstancedBufferGeometry();
    cg.index = box.index;
    cg.setAttribute("position", box.attributes.position);
    cg.setAttribute("normal", box.attributes.normal);
    const cref = new Float32Array(K * 2);
    for (let i = 0; i < K; i++) {
      cref[i * 2] = ((i % texSize) + 0.5) / texSize;
      cref[i * 2 + 1] = (Math.floor(i / texSize) + 0.5) / texSize;
    }
    cg.setAttribute("aRef", new THREE.InstancedBufferAttribute(cref, 2));
    cg.instanceCount = K;
    cg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.cubeUniforms = { uPosTex: { value: null }, uVelTex: { value: null }, uNear: { value: 18 } };
    const cubeMat = new THREE.ShaderMaterial({
      uniforms: this.cubeUniforms, vertexShader: CUBE_VERT, fragmentShader: CUBE_FRAG,
    });
    const cubes = new THREE.Mesh(cg, cubeMat);
    cubes.frustumCulled = false;
    cubes.visible = false; // hidden until a burst brings particles to life (see update())
    scene.add(cubes);
    this.cubes = cubes;
    this.points.visible = false;

    // density splat infrastructure (off-screen, additive)
    this.densityRT = new THREE.WebGLRenderTarget(128, 128, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.densityCam = new THREE.Camera();
    this.densityScene = new THREE.Scene();
    const dN = Math.min(n, 65536);
    const dref = new Float32Array(dN * 2);
    for (let i = 0; i < dN; i++) {
      dref[i * 2] = ((i % texSize) + 0.5) / texSize;
      dref[i * 2 + 1] = (Math.floor(i / texSize) + 0.5) / texSize;
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(dN * 3), 3));
    dgeo.setAttribute("aRef", new THREE.BufferAttribute(dref, 2));
    dgeo.setDrawRange(0, dN);
    dgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.densityUniforms = {
      uPosTex: { value: null }, uDensOrigin: { value: new THREE.Vector2(0, 0) }, uDensInvSize: { value: new THREE.Vector2(1, 1) },
    };
    const dmat = new THREE.ShaderMaterial({
      uniforms: this.densityUniforms, vertexShader: DENSITY_VERT, fragmentShader: DENSITY_FRAG,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    const dpoints = new THREE.Points(dgeo, dmat);
    dpoints.frustumCulled = false;
    this.densityScene.add(dpoints);
  }

  /** Splats current particles into the density grid (reads last frame's positions). */
  private densityPass(): void {
    const posTex = this.renderUniforms.uPosTex.value;
    if (!posTex) return;
    this.densityUniforms.uPosTex.value = posTex;
    const prev = this.renderer.getRenderTarget();
    const rc = new THREE.Color();
    this.renderer.getClearColor(rc);
    const ra = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.densityRT);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.densityScene, this.densityCam);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(rc, ra);
    this.velVar.material.uniforms.uDensityTex.value = this.densityRT.texture;
  }

  /** Arms an emitter slot; the next compute() spawns its slice of particles. */
  burst(x: number, y: number, z: number, o: BurstOptions): void {
    const ct = o.colorType ?? COLOR_TYPE[o.kind ?? "dust"];
    const strength = Math.min(1, o.strength ?? (o.count ?? 8) / 1200) * this.emissionScale;
    if (strength <= 0) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % EMITTERS;
    this.ePos[i].set(x, y, z, Math.random() * 1000);
    this.eParams[i].set(o.speed, o.life ?? 1.4, strength, ct);
  }

  update(dt: number, time: number, wind: { x: number; y: number; z: number }): void {
    // Largest life among emitters armed since last frame (each records life in eParams.y, strength in .z).
    let armedMaxLife = -1;
    for (let i = 0; i < EMITTERS; i++) if (this.eParams[i].z > 0 && this.eParams[i].y > armedMaxLife) armedMaxLife = this.eParams[i].y;
    const gate = idleGate(time, this.aliveUntil, armedMaxLife);
    this.aliveUntil = gate.aliveUntil;

    // Idle: nothing is alive → skip the density splat, both compute passes, and both draw layers. This
    // is the whole point — an empty/quiet scene must not pay the full 65 k-particle GPU cost every frame.
    if (!gate.active) {
      if (this.points.visible) { this.points.visible = false; this.cubes.visible = false; }
      return;
    }
    if (!this.points.visible) { this.points.visible = true; this.cubes.visible = true; }

    this.densityPass();
    for (const v of [this.velVar, this.posVar]) {
      v.material.uniforms.uTime.value = time;
      v.material.uniforms.uDt.value = Math.min(dt, 0.05);
      (v.material.uniforms.uWind.value as THREE.Vector3).set(wind.x, wind.y, wind.z);
    }
    this.gpu.compute();
    const posTex = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    const velTex = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    this.renderUniforms.uPosTex.value = posTex;
    this.renderUniforms.uVelTex.value = velTex;
    this.cubeUniforms.uPosTex.value = posTex;
    this.cubeUniforms.uVelTex.value = velTex;

    // disarm every emitter so each burst spawns exactly once
    for (let i = 0; i < EMITTERS; i++) this.eParams[i].z = 0;
  }

  debugCubeCount(): number {
    return this.cubeCount;
  }

  /** RMS horizontal spread of live particles around (cx,cz) — measures how far a pile spread. */
  debugSpread(cx: number, cz: number, radius: number): { count: number; rms: number } {
    const rt = this.gpu.getCurrentRenderTarget(this.posVar);
    const n = this.texSize * this.texSize;
    const buf = new Float32Array(n * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, this.texSize, this.texSize, buf);
    let count = 0, sum = 0;
    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      if (buf[i * 4 + 3] <= 0) continue;
      const dx = buf[i * 4] - cx, dz = buf[i * 4 + 2] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      count++;
      sum += d2;
    }
    return { count, rms: count ? Math.sqrt(sum / count) : 0 };
  }

  /** Supplies the world surface map so particles collide with structures, not just the ground. */
  setHeightField(tex: THREE.Texture, origin: THREE.Vector2, size: THREE.Vector2): void {
    for (const v of [this.velVar, this.posVar]) {
      v.material.uniforms.uHeightTex.value = tex;
      (v.material.uniforms.uHFOrigin.value as THREE.Vector2).copy(origin);
      (v.material.uniforms.uHFInvSize.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
      // density grid covers the same world region
      (v.material.uniforms.uDensOrigin.value as THREE.Vector2).copy(origin);
      (v.material.uniforms.uDensInvSize.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
    }
    this.densityUniforms.uDensOrigin.value.copy(origin);
    this.densityUniforms.uDensInvSize.value.set(1 / size.x, 1 / size.y);
  }

  /** Toggles particle-particle repulsion (used by the comparative verification). */
  setRepel(on: boolean): void {
    for (const v of [this.velVar, this.posVar]) v.material.uniforms.uRepel.value = on ? 1 : 0;
  }

  /**
   * Times only the per-frame CPU bookkeeping (emit + disarm), excluding GPU work.
   * This is O(1) in particle count — the per-particle simulation runs on the GPU.
   */
  debugTimeBookkeeping(iters: number): number {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      this.burst(0, 5, 0, { count: 10, color: 0, speed: 2, kind: "dust" });
      for (let j = 0; j < EMITTERS; j++) this.eParams[j].z = 0;
    }
    return (performance.now() - t0) / iters;
  }

  /** Reads back live-particle positions to verify collision (used by the headless probe). */
  debugProbe(minX: number, maxX: number, minZ: number, maxZ: number): {
    count: number; minY: number; maxY: number; below: number; live: number;
  } {
    const rt = this.gpu.getCurrentRenderTarget(this.posVar);
    const n = this.texSize * this.texSize;
    const buf = new Float32Array(n * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, this.texSize, this.texSize, buf);
    let count = 0, minY = Infinity, maxY = -Infinity, below = 0, live = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i * 4 + 3] <= 0) continue;
      live++;
      const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
      if (y < -0.05) below++;
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
        count++;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { count, minY: count ? minY : 0, maxY: count ? maxY : 0, below, live };
  }
}
