// Procedural game audio over ONE Web Audio context (no external sample files → nothing to license or
// bundle, works offline/on Render). Each effect is synthesised from a reused white-noise buffer +
// oscillators shaped by attack/decay gain envelopes, then fed through a generated CONVOLUTION REVERB
// (an urban impulse response) so world sounds carry a realistic spatial tail/echo. The live context
// also keeps the tab awake; it resumes on the first user gesture per the autoplay policy.
import { WEAPON_SFX, explosionParams, IMPACT_SFX, distanceGain, type SfxMaterial } from "./soundParams";

const MAT_MAP: Record<string, SfxMaterial> = {
  concrete: "concrete", brick: "brick", wood: "wood", glass: "glass", metal: "metal",
  gastank: "metal", dirt: "dirt", grass: "dirt",
  car_red: "metal", car_blue: "metal", car_teal: "metal", tire: "dirt",
};

// Which recorded sample each firearm plays (missing clip → the distinct per-weapon synth in shot() runs instead).
const SHOT_SAMPLE: Record<string, string> = {
  mg: "shot_rifle", bullet: "shot_rifle", shotgun: "shot_heavy",
  smg: "shot_smg", lmg: "shot_lmg", dmr: "shot_dmr", sniper: "shot_sniper", glauncher: "shot_glauncher",
};

const DIST_CURVES = new Map<number, Float32Array<ArrayBuffer>>(); // memoized WaveShaper curves per shape amount

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private reverbSend: GainNode | null = null; // world sounds tap this for a spatial tail
  private lowAudio = false;       // "bajo" preset: bypass the reverb convolver (heaviest audio-thread cost)
  private activeVoices = 0;       // live sample voices — capped so fire spam can't stack unbounded nodes
  private lastImpactAt = 0;       // impact-sound coalescing timestamp (ms)
  private readonly samples = new Map<string, AudioBuffer>(); // decoded ElevenLabs SFX (realistic layer)
  private rotorSrc: AudioBufferSourceNode | null = null;     // looping drone-rotor sample (if loaded)
  private rotorGain: GainNode | null = null;
  private rotorFilter: BiquadFilterNode | null = null;
  private rotorOsc: OscillatorNode | null = null;
  private rotorSubOsc: OscillatorNode | null = null;
  private rotorLfo: OscillatorNode | null = null;
  private rotorLowpass: BiquadFilterNode | null = null; // distance muffling: far = dull hum, near = bright whir
  private rotorPanner: StereoPannerNode | null = null;  // stereo pan by the drone's bearing (which side it's on)

  constructor() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.62;
      // Master-bus compressor: glues the mix and TAMES PEAKS when many sounds stack (a loud shot/blast ducks the
      // running sum instead of clipping) — the "ducking" glue for a busy battle. Cheap, always on.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 22; comp.ratio.value = 3.4; comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master.connect(comp); comp.connect(this.ctx.destination);
      // one reusable 2 s white-noise buffer feeds every burst/rotor
      const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 2), this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      // convolution reverb: a generated urban IR (decaying noise + a few early reflections) on a wet
      // send → shots/explosions/impacts get a believable outdoor tail instead of sounding "dead".
      const conv = this.ctx.createConvolver();
      conv.buffer = this.makeIR(1.0, 2.6); // shorter IR → far cheaper convolver (esp. Safari) with a still-audible tail
      const wet = this.ctx.createGain(); wet.gain.value = 0.9;
      const send = this.ctx.createGain(); send.gain.value = 1;
      send.connect(conv); conv.connect(wet); wet.connect(this.master);
      this.reverbSend = send;
      // a silent keep-alive oscillator keeps the tab's audio (and thus the game loop) awake while hidden
      const ka = this.ctx.createOscillator(), kg = this.ctx.createGain();
      kg.gain.value = 0; ka.connect(kg); kg.connect(this.ctx.destination); ka.start();
      const resume = () => this.ctx?.resume().catch(() => {});
      if (typeof window !== "undefined") { window.addEventListener("pointerdown", resume); window.addEventListener("keydown", resume); }
      this.loadSamples();
    } catch { this.ctx = null; }
  }

  /** Fetch + decode the realistic ElevenLabs SFX. Async + best-effort: until a clip is decoded (or if
   *  fetch fails, e.g. offline) the matching effect falls back to procedural synthesis. */
  private loadSamples(): void {
    if (!this.ctx) return;
    const base = import.meta.env.BASE_URL || "/";
    const names = ["shot_rifle", "shot_heavy", "explosion", "rotor", "impact_concrete", "impact_metal",
      "impact_glass", "voxel_break", "footstep", "land", "melee", "melee_hit", "hit", "death",
      // new realistic-SFX slots — drop the matching .mp3 in public/sfx/ and they auto-play (else the synth below runs)
      "shot_smg", "shot_lmg", "shot_dmr", "shot_sniper", "shot_glauncher", "explosion_big", "collapse",
      "scan_ping", "heal", "pickup"];
    for (const n of names) {
      fetch(`${base}sfx/${n}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then((b) => this.ctx!.decodeAudioData(b)).then((buf) => this.samples.set(n, buf)).catch(() => {});
    }
  }

  /** Plays a decoded sample through the spatial+reverb bus. Returns false if the clip isn't loaded
   *  (→ the caller uses its procedural fallback). `rate` pitch-shifts (with a little per-shot variance). */
  private playSample(key: string, dist: number, gain: number, rate = 1): boolean {
    const buf = this.samples.get(key);
    if (!buf || !this.ctx) return false;
    if (this.activeVoices >= 18) return true; // voice cap: silently drop (don't fall back to procedural under spam)
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(this.dest(dist));
    this.activeVoices++;
    src.onended = () => { this.activeVoices--; };
    src.start();
    return true;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.62;
    return this.muted;
  }

  /** Low-audio mode (weak GPU / "bajo"): drop the reverb convolver — the single heaviest audio cost. */
  setLowAudio(on: boolean): void { this.lowAudio = on; }

  // ---- synth primitives -------------------------------------------------------------------------
  /** A stereo urban impulse response: decaying noise + discrete early reflections (slap-back). */
  private makeIR(seconds: number, decayPow: number): AudioBuffer {
    const rate = this.ctx!.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx!.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decayPow);
      for (const r of [0.013, 0.027, 0.041, 0.063, 0.088]) { // building-face reflections
        const idx = Math.floor(r * rate); if (idx < len) d[idx] += (Math.random() * 2 - 1) * 0.6;
      }
    }
    return buf;
  }

  /** Soft-clip distortion curve — a touch of grit/saturation for blasts & heavy impacts.
   *  Memoized per shape amount (only a handful of distinct values ever used; the curve is deterministic). */
  private distCurve(amount: number): Float32Array<ArrayBuffer> {
    let c = DIST_CURVES.get(amount);
    if (!c) {
      const n = 1024;
      c = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) { const x = (i / n) * 2 - 1; c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x)); }
      DIST_CURVES.set(amount, c);
    }
    return c;
  }

  private env(gain: number, decay: number, t0: number, attack = 0.002): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    return g;
  }

  private noiseSrc(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = 0.9 + Math.random() * 0.2; // slight per-shot variation
    return s;
  }

  /** A filtered noise burst — the crack/thud/shatter body of most effects. `shape`>0 adds grit. */
  private burst(freq: number, type: BiquadFilterType, q: number, gain: number, decay: number, dest: AudioNode, when = 0, attack = 0.002, shape = 0): void {
    const t = this.ctx!.currentTime + when;
    const s = this.noiseSrc(), f = this.ctx!.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.env(gain, decay, t, attack);
    s.connect(f);
    if (shape > 0) { const w = this.ctx!.createWaveShaper(); w.curve = this.distCurve(shape); w.oversample = "2x"; f.connect(w); w.connect(g); }
    else f.connect(g);
    g.connect(dest);
    s.start(t); s.stop(t + attack + decay + 0.03);
  }

  /** A short tone (body thump / ring / sub-boom), optionally sweeping pitch. */
  private tone(freq: number, type: OscillatorType, gain: number, decay: number, dest: AudioNode, sweepTo?: number, when = 0, attack = 0.003): void {
    const t = this.ctx!.currentTime + when;
    const o = this.ctx!.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + decay);
    const g = this.env(gain, decay, t, attack);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + attack + decay + 0.03);
  }

  /** Destination for a spatial event `dist` metres away: attenuated dry to master + a reverb send. */
  private dest(dist: number): AudioNode {
    const g = this.ctx!.createGain();
    g.gain.value = dist > 0 ? distanceGain(dist) : 1;
    g.connect(this.master!);
    if (this.reverbSend && !this.lowAudio) {
      const s = this.ctx!.createGain();
      s.gain.value = 0.4 * (dist > 0 ? 1.3 : 1); // distant sounds are relatively wetter (more air)
      g.connect(s); s.connect(this.reverbSend);
    }
    return g;
  }

  // ---- effects ----------------------------------------------------------------------------------
  shot(weapon: string, dist = 0): void {
    if (!this.ctx) return;
    // each firearm has its OWN sample slot (falls back to the distinct synth below until the .mp3 is added)
    const sk = SHOT_SAMPLE[weapon];
    if (sk) {
      const g = sk === "shot_rifle" ? 4 : sk === "shot_heavy" ? 0.8 : 1.4; // existing clips are quiet → boosted; new clips ~unity
      if (this.playSample(sk, dist, g)) return;
    }
    const p = WEAPON_SFX[weapon] ?? WEAPON_SFX.mg, d = this.dest(dist);
    this.burst(6500, "highpass", 0.7, p.gain * 0.85, 0.014, d, 0, 0.0005);            // ignition SNAP (near-instant)
    this.burst(p.crackFreq, "bandpass", 1.5, p.gain, p.decay, d, 0, 0.0008, 0.5);     // the crack (gritty)
    this.tone(p.bodyFreq, "sine", p.gain * 0.8, p.decay * 1.7, d, p.bodyFreq * 0.42); // muzzle body/thump
    this.tone(p.bodyFreq * 1.6, "sawtooth", p.gain * 0.28, p.decay * 0.5, d, p.bodyFreq * 0.7); // low-mid punch
    this.burst(2400, "bandpass", 0.8, p.gain * 0.18, p.decay * 2.4, d, 0.012);         // report tail (into reverb)
    if (weapon === "sniper") { // a high-power rifle: supersonic CRACK + a long rolling echo + a deep chest thump
      this.burst(3400, "bandpass", 2.4, p.gain * 0.6, 0.05, d, 0.008, 0.0003);         // supersonic snap
      this.burst(820, "bandpass", 0.7, p.gain * 0.32, p.decay * 4, d, 0.06);           // long echo roll
      this.tone(46, "sine", p.gain * 0.5, p.decay * 3, d, 30);                          // deep chest thump
    }
  }

  /** Bolt-action rack after a sniper shot: lift + pull the bolt BACK (eject), then shove it FORWARD and lock
   *  it DOWN (chamber the next round). A short sequence of metallic clicks + a slide, scheduled a beat after
   *  the shot so it reads as "BANG … clack-clack". */
  boltCycle(): void {
    if (!this.ctx) return; const d = this.master!;
    this.burst(2900, "bandpass", 3.5, 0.26, 0.03, d, 0.28, 0.0004);  // bolt handle lifts (sharp tink)
    this.burst(1500, "highpass", 0.9, 0.13, 0.09, d, 0.33, 0.001);   // bolt slides BACK (scrape)
    this.burst(2400, "bandpass", 3.5, 0.30, 0.035, d, 0.55, 0.0004); // bolt shoves FORWARD (chunk)
    this.tone(300, "square", 0.16, 0.05, d, 210, 0.58);             // ...and locks DOWN (heavy thunk)
  }

  explosion(power: number, dist = 0): void {
    if (!this.ctx) return;
    // bigger blasts play louder + pitched DOWN (slower) so a mega-bomb reads as huge
    if (power > 700 && this.playSample("explosion_big", dist, Math.min(1, 0.6 + power / 2500))) return; // dedicated big-blast clip
    if (this.playSample("explosion", dist, Math.min(1, 0.5 + power / 2500), Math.max(0.7, 1.1 - power / 2200))) return;
    const p = explosionParams(power), d = this.dest(dist);
    this.burst(5000, "highpass", 0.6, p.gain * 0.55, 0.05, d, 0, 0.0006);            // sharp leading crack
    this.burst(170, "lowpass", 0.6, p.gain, p.decay * 1.25, d, 0, 0.004, 0.6);        // gritty boom body
    this.tone(p.subFreq, "sine", p.gain, p.decay * 1.5, d, p.subFreq * 0.32);         // deep sub with drop
    this.burst(85, "lowpass", 0.5, p.gain * 0.7, p.decay * 2.3, d, 0.03);             // long rumble tail
    for (let k = 0; k < 5; k++) {                                                     // debris crackle
      const dl = 0.04 + k * 0.05 + Math.random() * 0.04;
      this.burst(1500 + Math.random() * 2500, "bandpass", 1.4, p.gain * 0.14, 0.06, d, dl, 0.001);
    }
  }

  impact(material: string, dist = 0): void {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this.lastImpactAt < 30) return; // coalesce impact bursts (shotgun pellets, crossfire)
    this.lastImpactAt = now;
    const m = MAT_MAP[material] ?? "concrete";
    const sk = m === "metal" ? "impact_metal" : m === "glass" ? "impact_glass" : (m === "concrete" || m === "brick" || m === "wood") ? "impact_concrete" : null;
    if (sk && this.playSample(sk, dist, sk === "impact_concrete" ? 0.47 : 0.76)) return;
    const p = IMPACT_SFX[m], d = this.dest(dist);
    this.burst(p.freq, p.filter, p.ring ? 6 : 1, p.gain, p.decay, d, 0, 0.0008);
    if (p.ring) { this.tone(p.freq, "sine", p.gain * 0.45, p.decay, d); this.tone(p.freq * 2.01, "sine", p.gain * 0.2, p.decay * 0.8, d); }
    else this.burst(p.freq * 0.5, "lowpass", 0.8, p.gain * 0.4, p.decay * 1.4, d, 0.004); // debris thud
  }

  voxelBreak(dist = 0): void { if (!this.ctx) return; if (this.playSample("voxel_break", dist, 0.86)) return; const d = this.dest(dist); this.burst(720, "bandpass", 0.8, 0.32, 0.12, d, 0, 0.001); this.burst(300, "lowpass", 0.8, 0.16, 0.18, d, 0.01); }
  hit(): void { if (!this.ctx) return; if (this.playSample("hit", 0, 0.87)) return; const d = this.dest(0); this.burst(430, "lowpass", 1, 0.5, 0.11, d, 0, 0.001, 0.4); this.tone(190, "sawtooth", 0.3, 0.16, d, 90); }
  /** Crisp tick when OUR shot lands on an enemy; a two-note descending ding on a confirmed kill. */
  hitMarker(kill = false): void {
    if (!this.ctx) return; const d = this.dest(0);
    this.tone(kill ? 900 : 1650, "square", 0.15, 0.06, d, kill ? 540 : undefined, 0, 0.001);
    if (kill) this.tone(1320, "square", 0.13, 0.12, d, 680, 0.05, 0.001);
  }
  /** A two-tone klaxon when our base crosses a damage threshold — rotate to defend. */
  baseAlarm(): void {
    if (!this.ctx) return; const d = this.dest(0);
    this.tone(560, "sawtooth", 0.22, 0.22, d, 440, 0, 0.005);
    this.tone(560, "sawtooth", 0.22, 0.22, d, 440, 0.26, 0.005);
  }
  death(isHuman = true): void {
    if (!this.ctx) return;
    if (isHuman) { if (this.playSample("death", 0, 0.8)) return; const d = this.dest(0); this.tone(300, "sawtooth", 0.5, 0.75, d, 52); this.burst(500, "lowpass", 0.9, 0.3, 0.4, d, 0, 0.01); return; }
    // a DRONE dying — a mechanical crash, NEVER a human grunt: electrical fizz + metal crunch + motor spin-down
    const d = this.dest(0);
    this.burst(2000, "bandpass", 1.3, 0.4, 0.12, d, 0, 0.001);   // electrical arc/fizz
    this.burst(300, "lowpass", 1, 0.5, 0.24, d, 0, 0.001, 0.5);  // metal crunch (gritty)
    this.tone(220, "sawtooth", 0.4, 0.35, d, 55);                // rotor/motor spinning down
  }
  respawn(): void { if (this.ctx) this.tone(280, "sine", 0.4, 0.4, this.master!, 720); }
  weaponSwitch(): void { if (this.ctx) { this.burst(2600, "highpass", 1, 0.22, 0.05, this.master!); this.tone(900, "square", 0.12, 0.04, this.master!, 1300); } } // mechanical clack
  emptyClick(): void { if (this.ctx) this.burst(4200, "highpass", 2, 0.3, 0.03, this.master!, 0, 0.0004); }
  place(): void { if (this.ctx) this.tone(620, "square", 0.2, 0.06, this.master!); }
  erase(): void { if (this.ctx) this.burst(1500, "bandpass", 1, 0.24, 0.06, this.dest(0)); }
  footstep(run = false): void { if (!this.ctx) return; if (this.playSample("footstep", 0, run ? 1.5 : 1.06, run ? 1.12 : 1)) return; const d = this.dest(0); this.burst(run ? 720 : 470, "lowpass", 0.9, run ? 0.3 : 0.2, run ? 0.08 : 0.06, d, 0, 0.001); this.burst(run ? 2600 : 1900, "highpass", 0.8, run ? 0.06 : 0.04, 0.03, d, 0.004); } // heel thud + scuff
  jump(): void { if (this.ctx) this.tone(320, "sine", 0.25, 0.12, this.master!, 500); }
  land(): void { if (!this.ctx) return; if (this.playSample("land", 0, 0.9)) return; const d = this.dest(0); this.burst(280, "lowpass", 0.9, 0.42, 0.1, d, 0, 0.001); this.tone(120, "sine", 0.25, 0.14, d, 70); } // boot thud + body
  ui(): void { if (this.ctx) this.tone(880, "sine", 0.22, 0.08, this.master!, 1180); }
  melee(): void { if (!this.ctx) return; if (this.playSample("melee", 0, 0.4)) return; this.burst(1600, "bandpass", 0.8, 0.4, 0.16, this.dest(0), 0, 0.006); }  // swing whoosh
  meleeHit(): void { if (!this.ctx) return; if (this.playSample("melee_hit", 0, 0.85)) return; const d = this.dest(0); this.burst(470, "lowpass", 1, 0.55, 0.1, d, 0, 0.001, 0.5); this.tone(135, "square", 0.35, 0.13, d, 78); } // butt-strike thud
  lowBattery(): void { if (this.ctx) this.tone(1200, "square", 0.18, 0.12, this.master!, 800); }
  /** Frontal-scanner sonar: a rising sweep + a soft ping (sample slot: scan_ping). */
  scan(): void { if (!this.ctx) return; if (this.playSample("scan_ping", 0, 0.7)) return; const d = this.master!; this.tone(420, "sine", 0.16, 0.18, d, 1400, 0, 0.004); this.burst(2200, "bandpass", 3, 0.12, 0.14, d, 0.02, 0.002); this.tone(1500, "sine", 0.1, 0.1, d, 900, 0.16); }
  /** Bandage applied: a soft warm heal chime (sample slot: heal). */
  heal(): void { if (!this.ctx) return; if (this.playSample("heal", 0, 0.8)) return; const d = this.master!; this.tone(520, "sine", 0.18, 0.22, d, 780, 0, 0.01); this.tone(780, "sine", 0.12, 0.2, d, 1040, 0.08, 0.01); }
  /** Item pickup (ammo / medkit): a bright two-note pluck (sample slot: pickup). */
  pickup(): void { if (!this.ctx) return; if (this.playSample("pickup", 0, 0.8)) return; const d = this.master!; this.tone(700, "square", 0.16, 0.06, d, 1000, 0, 0.002); this.tone(1050, "square", 0.12, 0.07, d, 1400, 0.05, 0.002); }
  /** A structure collapsing: a deep rumble + a scatter of debris cracks (sample slot: collapse). */
  structureCollapse(dist = 0): void { if (!this.ctx) return; if (this.playSample("collapse", dist, 0.9)) return; const d = this.dest(dist); this.burst(140, "lowpass", 0.6, 0.5, 0.6, d, 0, 0.01, 0.5); this.tone(58, "sine", 0.4, 0.8, d, 34); for (let k = 0; k < 6; k++) this.burst(900 + Math.random() * 1800, "bandpass", 1.4, 0.14, 0.12, d, 0.05 + k * 0.07 + Math.random() * 0.05, 0.001); }

  /** Continuous drone rotor: layered noise + two saws + a blade-pass tremolo → a real quad-copper whir.
   *  level (0..1) sets loudness, speed sets pitch. Started lazily (never built in human-only matches). */
  setRotor(level: number, speed: number, maxGain = 0.05, pan = 0, cutoff = 6000): void {
    if (!this.ctx) return;
    if (!this.rotorGain) {
      if (level <= 0) return;
      const g = this.ctx.createGain(); g.gain.value = 0;
      const buf = this.samples.get("rotor");
      if (buf) {                              // realistic looping rotor sample
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        src.connect(g); src.start(); this.rotorSrc = src;
      } else {                                // procedural fallback: layered saws + a blade-pass tremolo
        const s = this.noiseSrc(), f = this.ctx.createBiquadFilter(), o = this.ctx.createOscillator(), sub = this.ctx.createOscillator();
        f.type = "bandpass"; f.frequency.value = 180; f.Q.value = 4;
        o.type = "sawtooth"; o.frequency.value = 80; sub.type = "sawtooth"; sub.frequency.value = 40;
        const lfo = this.ctx.createOscillator(), lfoGain = this.ctx.createGain();
        lfo.type = "sine"; lfo.frequency.value = 55; lfoGain.gain.value = 0.012;
        lfo.connect(lfoGain); lfoGain.connect(g.gain);
        s.connect(f); f.connect(g); o.connect(g); sub.connect(g);
        s.start(); o.start(); sub.start(); lfo.start();
        this.rotorFilter = f; this.rotorOsc = o; this.rotorSubOsc = sub; this.rotorLfo = lfo;
      }
      // spatial chain: gain(level) → lowpass(distance muffling) → stereo panner(bearing) → master
      const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = cutoff; lp.Q.value = 0.7;
      g.connect(lp);
      let tail: AudioNode = lp;
      if (typeof this.ctx.createStereoPanner === "function") { // panner may be absent on old engines
        const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
        lp.connect(p); tail = p; this.rotorPanner = p;
      }
      tail.connect(this.master!);
      this.rotorGain = g; this.rotorLowpass = lp;
    }
    const t = this.ctx.currentTime;
    this.rotorGain.gain.setTargetAtTime(Math.max(0, Math.min(maxGain, level * maxGain)), t, 0.08);
    if (this.rotorLowpass) this.rotorLowpass.frequency.setTargetAtTime(Math.max(120, cutoff), t, 0.1); // muffle with distance
    if (this.rotorPanner) this.rotorPanner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.06); // ease L/R (no zipper)
    if (this.rotorSrc) {
      this.rotorSrc.playbackRate.setTargetAtTime(0.82 + speed * 0.008, t, 0.15); // pitch rises with throttle
    } else if (this.rotorFilter) {
      this.rotorFilter.frequency.setTargetAtTime(150 + speed * 9, t, 0.1);
      this.rotorOsc!.frequency.setTargetAtTime(68 + speed * 3.5, t, 0.1);
      this.rotorSubOsc!.frequency.setTargetAtTime(34 + speed * 1.7, t, 0.1);
      this.rotorLfo!.frequency.setTargetAtTime(48 + speed * 2.2, t, 0.1);
    }
  }
}
